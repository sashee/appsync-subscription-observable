import { appsyncRealtime, persistentSubscription } from "./lib.js";
import WebSocket, {WebSocketServer} from "ws";
import { generateCert } from "./testcert.js";
import {createServer} from "node:https";
import getPort from "get-port";
import {describe, it, test, mock} from "node:test";
import {lastValueFrom, of, from, ReplaySubject, firstValueFrom, Subject} from "rxjs";
import {filter, first, shareReplay, map, catchError, sequenceEqual, mergeMap, tap, take, skip} from "rxjs/operators";
import _ from "lodash";
import assert from "node:assert/strict";
import {setTimeout} from "node:timers/promises";

process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = 0;

const debug = false;

const debugTap = (label) => tap({
	subscribe: () => console.log(`${label}.subscribe`),
	next: (e) => console.log(`${label}.next`, e),
	error: (e) => console.log(`${label}.error`, e),
	complete: () => console.log(`${label}.complete`),
	unsubscribe: () => console.log(`${label}.unsubscribe`),
	finalize: () => console.log(`${label}.finalize`),
});

process.on("uncaughtException", function (err) {
	console.error("UNCAUGHT ERROR", err.message);
	console.error(err);
});

const subscriptionQuery = `subscription MySubscription {
	singleton {
		data
		last_updated
	}
}
`;

const subscriptionVariables = {};

const withTestSetup = (connectionRetryConfig) => async (fn) => {
	const port = await getPort();

	const cert = generateCert({altNameIPs: ["127.0.0.1"], validityDays: 2});
	const server = createServer({
		cert: cert.cert,
		key: cert.privateKey,
	});

	const wss = new WebSocketServer({server});

	const connections = new ReplaySubject();
	wss.on("connection", (ws, req) => {
		const connectionSubject = new ReplaySubject();
		ws.on("error", (e) => connectionSubject.next({type: "error", error: e}));
		ws.on("message", (m) => {
			connectionSubject.next({type: "message", message: JSON.parse(Buffer.from(m, "utf8").toString())});
		});
		ws.on("open", () => connectionSubject.next({type: "open"}));
		ws.on("close", () => connectionSubject.complete());

		const send = (message) => {
			debug && (console.log("[tester] ws.send", message));
			ws.send(JSON.stringify(message));
		};
		debug && (console.log("[tester] new connectionSubject"));
		debug && (connectionSubject.subscribe(({
			next: (e) => console.log("[tester] connectionSubject.next", e),
			error: (e) => console.log("[tester] connectionSubject.error", e),
			complete: () => console.log("[tester] connectionSubject.complete"),
		})));

		connections.next({connectionSubject, send, url: req.url, ws});
	});

	server.listen(port);
	
	const tester = appsyncRealtime({APIURL: `https://127.0.0.1:${port}`, connectionRetryConfig, WebSocketCtor: WebSocket});

	try {
		return await fn({tester, connections});
	}finally {
		await new Promise((res) => {
			server.close(res);
		});
		connections.complete();
	}
};

const handleConnections = ({connections, newConnection, newSubscription, disableAutoAckConnection, disableAutoAckSubscription}) => {
	const openConnections = {};
	let numConnections = 0;
	connections.pipe(
	).subscribe(({connectionSubject, send, url, ws}) => {
		const connectionNum = numConnections++;
		openConnections[connectionNum] = ({messages: openConnections[connectionNum]?.messages ?? [], connectionSubject, subscriptions: openConnections[connectionNum]?.subscriptions ?? {}});
		let numSubscriptions = 0;
		newConnection?.({url, connectionSubject, connectionNum, ws});
		const messages = connectionSubject.pipe(
			filter(({type}) => type === "message"),
			map(({message}) => message),
			shareReplay(),
		);

		const connectionObj = openConnections[connectionNum];
		if (!disableAutoAckConnection) {
			messages.pipe(filter(({type}) => type === "connection_init")).subscribe(async () => {
				send({type: "connection_ack", payload: {connectionTimeoutMs: 10000}});
				const messageQueue = connectionObj.messages;
				connectionObj.messages = {push: send};
				messageQueue.forEach((message) => send(message));
			});
		}else {
			if (connectionObj.messages.length > 0) {
				throw new Error("Can't queue messages when connection auto-ack is disabled");
			}
			connectionObj.messages = {push: send};
		}
		messages.pipe(filter(({type}) => type === "start")).subscribe((message) => {
			const subscriptionNum = numSubscriptions++;
			const {id, payload} = message;
			newSubscription?.({payload, connectionNum, subscriptionNum, id});
			openConnections[connectionNum].subscriptions[subscriptionNum] = openConnections[connectionNum].subscriptions[subscriptionNum] ?? {messages: []};
			const subscriptionObj = openConnections[connectionNum].subscriptions[subscriptionNum];
			if (!disableAutoAckSubscription) {
				send({type: "start_ack", id});
				const messageQueue = subscriptionObj.messages;
				subscriptionObj.messages = {push: (msg) => send({...msg, id})};
				messageQueue.forEach((msg) => send({...msg, id}));
			}else {
				if (subscriptionObj.messages.length > 0) {
					throw new Error("Can't queue messages when subscription auto-ack is disabled");
				}
				subscriptionObj.messages = {push: (msg) => send({...msg, id})};
			}
		});
	});
	return {
		sendMessageToConnection: (connectionNum, message) => {
			openConnections[connectionNum] = openConnections[connectionNum] ?? {messages: [], subscriptions: {}};
			openConnections[connectionNum].messages.push(message);
		},
		sendMessageToSubscription: (connectionNum, subscriptionNum, message) => {
			openConnections[connectionNum] = openConnections[connectionNum] ?? {messages: [], subscriptions: {}};
			openConnections[connectionNum].subscriptions[subscriptionNum] = openConnections[connectionNum].subscriptions[subscriptionNum] ?? {messages: []};
			openConnections[connectionNum].subscriptions[subscriptionNum].messages.push(message);
		},
		closeSubscription: (connectionNum, subscriptionNum) => openConnections[connectionNum][subscriptionNum].push({type: "complete"}),
		waitForConnection: (connectionNum) => firstValueFrom(
			connections.pipe(
				skip(connectionNum),
				first(),
				mergeMap(({connectionSubject}) => connectionSubject.pipe(
					filter(({type, message}) => type === "message" && message.type === "connection_init")
				))
			)
		),
		waitForSubscription: (connectionNum, subscriptionNum) => firstValueFrom(
			connections.pipe(
				skip(connectionNum),
				first(),
				mergeMap(({connectionSubject}) => connectionSubject.pipe(
					filter(({type, message}) => type === "message" && message.type === "start"),
					skip(subscriptionNum),
					first(),
				))
			)
		),
	};
};

const equalityCheck = (source, expected) => {
	return lastValueFrom(source.pipe(
		map((v) => ({type: "data", payload: v})),
		catchError((e) => of({type: "error", payload: e})),
		sequenceEqual(from(expected), (a, b) => {
			return Object.entries(a).every(([k,v]) => !b[k] || _.isEqual(b[k], v));
		})),
	);
};

describe("connection", () => {
	it("emits an error if failed", async () => {
		const port = await getPort();
		const tester = appsyncRealtime({APIURL: `https://127.0.0.1:${port}`, WebSocketCtor: WebSocket})({getAuthorizationHeaders: () => ({auth: "header"})})(subscriptionQuery, subscriptionVariables);

		assert(await equalityCheck(tester, [{type: "error"}]));
	});

	it("emits an error for an error event for the connection", async () => {
		return withTestSetup({maxAttempts: 1})(async ({tester, connections}) => {
			const {sendMessageToConnection} = handleConnections({
				connections,
			});
			sendMessageToConnection(0, {type: "error", payload: "test error"});
			const subs = tester({getAuthorizationHeaders: () => null})(subscriptionQuery, subscriptionVariables);
			assert(await equalityCheck(subs, [{type: "error", payload: "test error"}]));
		});
	});

	it("emits an error if the connection ack is missing", async () => {
		return withTestSetup({maxAttempts: 1, timeout: 50})(async ({tester, connections}) => {
			handleConnections({
				disableAutoAckConnection: true,
				connections,
			});
			const subs = tester({getAuthorizationHeaders: () => null})(subscriptionQuery, subscriptionVariables);
			assert(await equalityCheck(subs, [{type: "error"}]));
		});
	});

	it("retries connection if it fails", async () => {
		return withTestSetup({maxAttempts: 3, timeout: 50})(async ({tester, connections}) => {
			const {waitForConnection, waitForSubscription, sendMessageToConnection, sendMessageToSubscription} = handleConnections({
				disableAutoAckConnection: true,
				connections,
				newConnection: async ({connectionNum}) => {
					if (connectionNum === 2) {
						await waitForConnection(2);
						sendMessageToConnection(2, {type: "connection_ack", payload: {connectionTimeoutMs: 100}});
						await waitForSubscription(2, 0);
						sendMessageToSubscription(2, 0, {type: "data", payload: "success"});
					}
				},
			});
			const subs = tester({getAuthorizationHeaders: () => null})(subscriptionQuery, subscriptionVariables);
			assert(await equalityCheck(subs, [{type: "data", payload: "success"}]));
		});
	});

	it("emits an end if the ws is closed", async () => {
		return withTestSetup()(async ({tester, connections}) => {
			const {waitForConnection, waitForSubscription, sendMessageToConnection, sendMessageToSubscription} = handleConnections({
				connections,
				newConnection: async ({ws}) => {
					await waitForSubscription(0, 0);
					sendMessageToSubscription(0, 0, {type: "data", payload: "success"});
					await setTimeout(100);
					ws.close();
				}
			});
			const subs = tester({getAuthorizationHeaders: () => null})(subscriptionQuery, subscriptionVariables);
			assert(await equalityCheck(subs, [{type: "data", payload: "success"}]));
		});
	});

	it("completes the connection if a ka is missing", async () => {
		return withTestSetup()(async ({tester, connections}) => {
			const {sendMessageToConnection, waitForConnection} = handleConnections({
				disableAutoAckConnection: true,
				connections,
				newConnection: async () => {
					await waitForConnection(0);
					sendMessageToConnection(0, {type: "connection_ack", payload: {connectionTimeoutMs: 100}});
				}
			});
			const subs = tester({getAuthorizationHeaders: () => null})(subscriptionQuery, subscriptionVariables);
			assert(await equalityCheck(subs, []));
		});
	});

	it("receiving ka's keeps the connection open", async () => {
		return withTestSetup()(async ({tester, connections}) => {
			let shouldFinish = false;
			const {sendMessageToConnection, waitForConnection} = handleConnections({
				disableAutoAckConnection: true,
				connections,
				newConnection: async () => {
					await waitForConnection(0);
					sendMessageToConnection(0, {type: "connection_ack", payload: {connectionTimeoutMs: 100}});
					await setTimeout(50);
					sendMessageToConnection(0,{type: "ka"});
					await setTimeout(50);
					sendMessageToConnection(0,{type: "ka"});
					await setTimeout(50);
					sendMessageToConnection(0,{type: "ka"});
					await setTimeout(50);
					sendMessageToConnection(0,{type: "ka"});
					await setTimeout(50);
					sendMessageToConnection(0,{type: "ka"});
					shouldFinish = true;
				}
			});
			const subs = tester({getAuthorizationHeaders: () => null})(subscriptionQuery, subscriptionVariables);
			assert(await equalityCheck(subs, []));
			assert(shouldFinish);
		});
	});
	it("reuses the connection for multiple subscriptions", async () => {
		return withTestSetup()(async ({tester, connections}) => {
			const newConnection = mock.fn(() => {});
			const newSubscription = mock.fn(({payload, subscriptionNum}) => {
				if (subscriptionNum === 0) {
					assert.deepStrictEqual(payload.extensions, {authorization: {subscription: "1"}});
				}else if (subscriptionNum === 1) {
					assert.deepStrictEqual(payload.extensions, {authorization: {subscription: "2"}});
				}else {
					throw new Error("Unexpected subscription");
				}
			});
			const {sendMessageToSubscription} = handleConnections({
				connections,
				newConnection,
				newSubscription,
			});
			const subs1 = new ReplaySubject();
			const subs2 = new ReplaySubject();
			tester({getAuthorizationHeaders: () => ({subscription: "1"})})(subscriptionQuery, subscriptionVariables).subscribe(subs1);
			sendMessageToSubscription(0, 0, {type: "data", payload: {data: "result"}});
			await setTimeout(100);
			assert.equal(newSubscription.mock.callCount(), 1);
			tester({getAuthorizationHeaders: () => ({subscription: "2"})})(subscriptionQuery, subscriptionVariables).subscribe(subs2);
			await setTimeout(100);
			sendMessageToSubscription(0, 0, {type: "complete"});
			sendMessageToSubscription(0, 1, {type: "complete"});
			assert(await equalityCheck(subs1, [{type: "data", payload: {data: "result"}}]));
			assert(await equalityCheck(subs2, []));
			assert.equal(newSubscription.mock.callCount(), 2);
			assert.equal(newConnection.mock.callCount(), 1);
		});
	});
	it("closes the connection when the last submission is closed", async () => {
		return withTestSetup()(async ({tester, connections}) => {
			let connection;
			const newConnection = mock.fn(({connectionSubject}) => {
				connection = connectionSubject;
			});
			const {waitForConnection, sendMessageToSubscription} = handleConnections({
				connections,
				newConnection,
			});
			const subs1 = new ReplaySubject();
			tester({getAuthorizationHeaders: () => null})(subscriptionQuery, subscriptionVariables).subscribe(subs1);
			await waitForConnection(0);
			sendMessageToSubscription(0, 0, {type: "complete"});
			// connection is complete
			await lastValueFrom(connection);
		});
	});
	it("opens a new connection after closing all subscriptions then opening new ones", async () => {
		return withTestSetup()(async ({tester, connections}) => {
			let connection;
			const newConnection = mock.fn(({connectionSubject}) => {
				connection = connectionSubject;
			});
			const {waitForConnection, sendMessageToSubscription} = handleConnections({
				connections,
				newConnection,
			});
			const subs1 = new ReplaySubject();
			tester({getAuthorizationHeaders: () => null})(subscriptionQuery, subscriptionVariables).subscribe(subs1);
			await waitForConnection(0);
			sendMessageToSubscription(0, 0, {type: "complete"});
			assert.equal(newConnection.mock.callCount(), 1);
			await lastValueFrom(connection);
			const subs2 = new ReplaySubject();
			tester({getAuthorizationHeaders: () => null})(subscriptionQuery, subscriptionVariables).subscribe(subs2);
			await waitForConnection(1);
			sendMessageToSubscription(1, 0, {type: "complete"});
			assert.equal(newConnection.mock.callCount(), 2);
			await lastValueFrom(connection);
		});
	});
});

describe("auth headears", () => {
	test("sends the authorization headers for both the connection and the subscription", async () => {
		return withTestSetup()(async ({tester, connections}) => {
			const newConnection = mock.fn(({url}) => {
				const parsed = new URL(url, "https://example.com");
				assert(parsed.pathname === "/realtime");
				const header = JSON.parse(Buffer.from(parsed.searchParams.get("header"), "base64").toString());
				const payload = Buffer.from(parsed.searchParams.get("payload"), "base64").toString();
				assert.equal(payload, "{}");
				assert.deepStrictEqual(header, {test: "authheader", connect: true, data: {}});
			});

			const newSubscription = mock.fn(({payload}) => {
				assert.deepStrictEqual(payload.extensions, {authorization: {test: "authheader", connect: false, data: JSON.parse(payload.data)}});
			});

			const {sendMessageToSubscription} = handleConnections({
				connections,
				newConnection,
				newSubscription,
			})
			const subs = tester({getAuthorizationHeaders: ({connect, data}) => ({test: "authheader", connect, data})})(subscriptionQuery, subscriptionVariables);
			sendMessageToSubscription(0, 0, {type: "complete"});
			assert(await equalityCheck(subs, []));
			assert.equal(newConnection.mock.callCount(), 1);
			assert.equal(newSubscription.mock.callCount(), 1);
		});
	});
	it("sends the new subscription's headers when a new connection is opened", async () => {
		return withTestSetup()(async ({tester, connections}) => {
			const newConnection = mock.fn(({url}) => {
				const parsed = new URL(url, "https://example.com");
				assert(parsed.pathname === "/realtime");
				const header = JSON.parse(Buffer.from(parsed.searchParams.get("header"), "base64").toString());
				const payload = Buffer.from(parsed.searchParams.get("payload"), "base64").toString();
				assert.equal(payload, "{}");
				assert.deepStrictEqual(header, {test: "authheader", connect: true, data: {}});
			});

			const newSubscription = mock.fn(({payload, connectionNum, subscriptionNum}) => {
				assert.deepStrictEqual(payload.extensions, {authorization: {test: "authheader", connect: false, data: JSON.parse(payload.data)}});
			});

			const {sendMessageToSubscription} = handleConnections({
				connections,
				newConnection,
				newSubscription,
			})
			const subs = tester({getAuthorizationHeaders: ({connect, data}) => ({test: "authheader", connect, data})})(subscriptionQuery, subscriptionVariables);
			sendMessageToSubscription(0, 0, {type: "complete"});
			assert(await equalityCheck(subs, []));

			newConnection.mock.mockImplementation(({url}) => {
				const parsed = new URL(url, "https://example.com");
				assert(parsed.pathname === "/realtime");
				const header = JSON.parse(Buffer.from(parsed.searchParams.get("header"), "base64").toString());
				const payload = Buffer.from(parsed.searchParams.get("payload"), "base64").toString();
				assert.equal(payload, "{}");
				assert.deepStrictEqual(header, {test: "authheader2", connect: true, data: {}});
			});

			newSubscription.mock.mockImplementation(({payload, connectionNum, subscriptionNum}) => {
				assert.deepStrictEqual(payload.extensions, {authorization: {test: "authheader2", connect: false, data: JSON.parse(payload.data)}});
			});
			const subs2 = tester({getAuthorizationHeaders: ({connect, data}) => ({test: "authheader2", connect, data})})(subscriptionQuery, subscriptionVariables);
			sendMessageToSubscription(1, 0, {type: "complete"});
			assert(await equalityCheck(subs2, []));
		});
	});
	it("does not connect to the websocket if the an unsubscribe happens before the connection auth headers are retrieved", async () => {
		return withTestSetup()(async ({tester, connections}) => {
			const newConnection = mock.fn(() => {});
			handleConnections({
				connections,
				newConnection,
			});
			const subs = tester({getAuthorizationHeaders: () => setTimeout(200).then(() => ({auth: "1"}))})(subscriptionQuery, subscriptionVariables).subscribe({next: (e) => console.log(e)});
			await setTimeout(100);
			subs.unsubscribe();
			await setTimeout(150);
			assert.equal(newConnection.mock.callCount(), 0);
		});
	});
	it("does not start a subscription if the an unsubscribe happens before the subscription auth headers are retrieved", async () => {
		return withTestSetup()(async ({tester, connections}) => {
			const newConnection = mock.fn(() => {});
			const newSubscription = mock.fn(() => {});
			handleConnections({
				connections,
				newConnection,
				newSubscription,
			});
			const subs = tester({getAuthorizationHeaders: ({connect}) => setTimeout(connect ? 0 : 200).then(() => ({auth: "1"}))})(subscriptionQuery, subscriptionVariables).subscribe({next: (e) => console.log(e)});
			await setTimeout(100);
			subs.unsubscribe();
			await setTimeout(150);
			assert.equal(newConnection.mock.callCount(), 1);
			assert.equal(newSubscription.mock.callCount(), 0);
		});
	});
	it("emits an error if the auth headers can not be retrieved for the connection", async () => {
		return withTestSetup()(async ({tester, connections}) => {
			handleConnections({
				connections,
			});
			const subs = tester({getAuthorizationHeaders: ({connect}) => Promise.reject(), subscriptionRetryConfig: {maxAttempts: 1}})(subscriptionQuery, subscriptionVariables);
			assert(await equalityCheck(subs, [{type: "error"}]));
		});
	});
	it("emits an error if the auth headers can not be retrieved for the subscription", async () => {
		return withTestSetup()(async ({tester, connections}) => {
			handleConnections({
				connections,
			});
			const subs = tester({getAuthorizationHeaders: ({connect}) => connect ? Promise.resolve({test: "headers"}) : Promise.reject(), subscriptionRetryConfig: {maxAttempts: 1}})(subscriptionQuery, subscriptionVariables);
			assert(await equalityCheck(subs, [{type: "error"}]));
		});
	});
	it("emits an error if the auth headers for the connection take too long to generate", async () => {
		return withTestSetup()(async ({tester, connections}) => {
			handleConnections({
				connections,
			});
			const subs = tester({getAuthorizationHeaders: ({connect}) => setTimeout(200).then(() => Promise.reject()), subscriptionRetryConfig: {maxAttempts: 1, timeout: 100}})(subscriptionQuery, subscriptionVariables);
			assert(await equalityCheck(subs, [{type: "error"}]));
		});
	});
	it("emits an error if the auth headers for the connection take too long to generate", async () => {
		return withTestSetup()(async ({tester, connections}) => {
			handleConnections({
				connections,
			});
			const subs = tester({getAuthorizationHeaders: ({connect}) => connect ? Promise.resolve({test: "headers"}) : setTimeout(200).then(() => Promise.reject()), subscriptionRetryConfig: {maxAttempts: 1, timeout: 100}})(subscriptionQuery, subscriptionVariables);
			assert(await equalityCheck(subs, [{type: "error"}]));
		});
	});
});

describe("subscription", () => {
	it("emits an error if the subscription_ack is missing", async () => {
		return withTestSetup({maxAttempts: 1, timeout: 50})(async ({tester, connections}) => {
			handleConnections({
				disableAutoAckSubscription: true,
				connections,
			});
			const subs = tester({getAuthorizationHeaders: () => null, subscriptionRetryConfig: {maxAttempts: 1, timeout: 50}})(subscriptionQuery, subscriptionVariables);
			assert(await equalityCheck(subs, [{type: "error"}]));
		});
	});
	it("retries the subsciption if there was no subscription_ack", async () => {
		return withTestSetup({maxAttempts: 3, timeout: 50})(async ({tester, connections}) => {
			const {waitForConnection, waitForSubscription, sendMessageToConnection, sendMessageToSubscription} = handleConnections({
				disableAutoAckSubscription: true,
				connections,
				newSubscription: async ({subscriptionNum, id}) => {
					if (subscriptionNum === 2) {
						await waitForSubscription(0, 2);
						sendMessageToSubscription(0, 2, {type: "start_ack"});
						sendMessageToSubscription(0, 2, {type: "data", payload: "success"});
						sendMessageToSubscription(0, 2, {type: "complete"});
					}
				},
			});
			const subs = tester({getAuthorizationHeaders: () => null, subscriptionRetryConfig: {maxAttempts:3, timeout: 50}})(subscriptionQuery, subscriptionVariables);
			assert(await equalityCheck(subs, [{type: "data", payload: "success"}]));
		});
	});
	it("retries the subscrition if there was an error instead of an ack", async () => {
		return withTestSetup({maxAttempts: 3, timeout: 50})(async ({tester, connections}) => {
			const {waitForConnection, waitForSubscription, sendMessageToConnection, sendMessageToSubscription} = handleConnections({
				disableAutoAckSubscription: true,
				connections,
				newSubscription: async ({subscriptionNum, id}) => {
					if (subscriptionNum === 2) {
						await waitForSubscription(0, 2);
						sendMessageToSubscription(0, 2, {type: "start_ack"});
						sendMessageToSubscription(0, 2, {type: "data", payload: "success"});
						sendMessageToSubscription(0, 2, {type: "complete"});
					}else {
						await waitForSubscription(0, subscriptionNum);
						sendMessageToSubscription(0, subscriptionNum, {type: "error", payload: "error"});
					}
				},
			});
			const subs = tester({getAuthorizationHeaders: () => null, subscriptionRetryConfig: {maxAttempts:3, timeout: 200}})(subscriptionQuery, subscriptionVariables);
			await Promise.race([
				(async () => assert(await equalityCheck(subs, [{type: "data", payload: "success"}])))(),
				setTimeout(100).then(() => {throw new Error("Should have finished already")}),
			]);
			;
		});
	});
	it("receives data messages", async () => {
		return withTestSetup()(async ({tester, connections}) => {
			const {sendMessageToSubscription} = handleConnections({
				connections,
			});
			const subs = tester({getAuthorizationHeaders: () => null})(subscriptionQuery, subscriptionVariables);
			sendMessageToSubscription(0, 0, {type: "data", payload: {data: "result"}});
			sendMessageToSubscription(0, 0, {type: "complete"});
			assert(await equalityCheck(subs, [{type: "data", payload: {data: "result"}}]));
		});
	});
	it("emits a complete if the subscription is completed", async () => {
		return withTestSetup()(async ({tester, connections}) => {
			const {sendMessageToSubscription} = handleConnections({
				connections,
			});
			const complete = mock.fn(() => {});
			const subs = tester({getAuthorizationHeaders: () => null})(subscriptionQuery, subscriptionVariables).pipe(shareReplay());
			subs.subscribe(({
				complete,
			}));
			sendMessageToSubscription(0, 0, {type: "data", payload: {data: "result"}});
			sendMessageToSubscription(0, 0, {type: "complete"});
			assert(await equalityCheck(subs, [{type: "data", payload: {data: "result"}}]));
			assert.equal(complete.mock.callCount(), 1);
		});
	});
	it("emits an error for an error message", async () => {
		return withTestSetup()(async ({tester, connections}) => {
			const {sendMessageToSubscription} = handleConnections({
				connections,
			});
			const error = mock.fn((e) => {});
			const subs = tester({getAuthorizationHeaders: () => null})(subscriptionQuery, subscriptionVariables).pipe(shareReplay());
			subs.subscribe(({
				error,
			}));
			sendMessageToSubscription(0, 0, {type: "data", payload: {data: "result"}});
			sendMessageToSubscription(0, 0, {type: "error", payload: "test error"});
			assert(await equalityCheck(subs, [{type: "data", payload: {data: "result"}}, {type: "error", payload: "test error"}]));
			assert.equal(error.mock.callCount(), 1);
			assert.equal(error.mock.calls[0].arguments[0], "test error");
		});
	});
	it("won't start a subscription if it was closed before the connection was established", async () => {
		return withTestSetup()(async ({tester, connections}) => {
			const complete = mock.fn(() => {});
			handleConnections({
				disableAutoAckConnection: true,
				connections,
				newConnection: ({connectionSubject}) => {
					connectionSubject.subscribe(({
						complete,
					}));
				},
			});
			const subs = tester({getAuthorizationHeaders: () => null})(subscriptionQuery, subscriptionVariables).subscribe(({
				next: (e) => console.log(e),
			}));
			await setTimeout(100);
			subs.unsubscribe();
			await setTimeout(100);
			assert.equal(complete.mock.callCount(), 1);
		});
	});
	it("calls the opened function when the start_ack is received", async () => {
		return withTestSetup({maxAttempts: 3, timeout: 50})(async ({tester, connections}) => {
			const opened = mock.fn(() => {});
			const {waitForSubscription, sendMessageToSubscription} = handleConnections({
				disableAutoAckSubscription: true,
				connections,
				newSubscription: async () => {
					await waitForSubscription(0, 0);
					assert.equal(opened.mock.callCount(), 0);
					sendMessageToSubscription(0, 0, {type: "start_ack"});
					await setTimeout(50);
					assert.equal(opened.mock.callCount(), 1);
					sendMessageToSubscription(0, 0, {type: "complete"});
				},
			});
			const subs = tester({getAuthorizationHeaders: () => null, opened})(subscriptionQuery, subscriptionVariables);
			assert(await equalityCheck(subs, []));
		});
	});
});

describe("persistentSubscription", () => {
	it("reconnects automatically if the connection is closed", async () => {
		return withTestSetup({maxAttempts: 1, timeout: 50})(async ({tester, connections}) => {
			const opened = new Subject();
			handleConnections({
				connections,
				newConnection: async ({ws}) => {
					opened.pipe(take(1)).subscribe(async () => {
						ws.close();
					});
				},
			});
			const subs = persistentSubscription(tester)({closed: (e) => console.log("closed", e), getAuthorizationHeaders: () => null, subscriptionRetryConfig: {maxAttempts: 1}, opened: () => opened.next(), reopenTimeoutOnComplete: 10, reopenTimeoutOnError: 10})(subscriptionQuery, subscriptionVariables).subscribe(() => {});
			await firstValueFrom(connections.pipe(skip(2), take(1)));
			subs.unsubscribe();
		});
	});
	it("reconnects automatically if the connection has an error", async () => {
		return withTestSetup({maxAttempts: 1, timeout: 50})(async ({tester, connections}) => {
			const opened = new Subject();
			const {sendMessageToConnection} = handleConnections({
				connections,
				newConnection: async ({connectionNum}) => {
					opened.pipe(take(1)).subscribe(async () => {
						sendMessageToConnection(connectionNum, {type: "error"});
					});
				},
			});
			const subs = persistentSubscription(tester)({closed: (e) => console.log("closed", e), getAuthorizationHeaders: () => null, subscriptionRetryConfig: {maxAttempts: 1}, opened: () => opened.next(), reopenTimeoutOnComplete: 10, reopenTimeoutOnError: 10})(subscriptionQuery, subscriptionVariables).subscribe(() => {});
			await firstValueFrom(connections.pipe(skip(2), take(1)));
			subs.unsubscribe();
		});
	});
});
