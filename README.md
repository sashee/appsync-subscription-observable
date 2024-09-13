# AppSync subscription implemented as an RxJs observable

This library provides an optimized way to subscribe to AppSync updates and get a stream of events. It aims to hide the connection management part and behaves as each subscription has its own connection.

It implements the AppSync websocket protocol [detailed here](https://docs.aws.amazon.com/appsync/latest/devguide/real-time-websocket-client.html) with only RxJS as a dependency.

It handles:

* Reuses the same connection for multiple subscriptions
* The authorization headers used for the connection are the same as the subscription that opened that connection. This makes it easy to refresh authorization for reconnections.
* Provides an ```opened``` handler that is called when AppSync sends the ```start_ack``` message. This makes it possible to reliably know when events are expected
* Allows defining the retry parameters for both the connection and the subscription

## Installation

```
npm install appsync-subscription-observable
```

## Usage

Initialize the connection object:

```js
import { appsyncRealtime } from "appsync-subscription-observable";

// APIURL is the AppSync GraphQL URL
const connection = appsyncRealtime({APIURL});
```

Subscribe to updates:

```js
connection({getAuthorizationHeaders: () => ({...})(query, variables)
  .subscribe({
    next: (e) => console.log("new item", e),
    error: (e) => console.log("error", e),
    complete: () => console.log("complete"),
  });
```

## Options

### appsyncRealtime

#### ```APIURL``` (requried)

AppSync GraphQL endpoint.

#### ```connectionRetryConfig```

Defines the retry parameters when the connection can not be establised. The time to wait between attempts is calculated as: ```Math.min(base ^ retryCount, cap)```. The values that can be configured:
  * ```base```: The base value for the exponential backoff
  * ```cap```: The max time between two retries
  * ```maxAttempts```: The maximum number of times to retry before erroring
  * ```timeout```: How much time to wait in each try for the connection to be established

#### ```closeDelay```

An observable factory that can delay closing the connection when all subscription are unsubscribed.

Example:

```
import {timer} from "rxjs";

// wait 6 seconds before closing the connection
const connection = appsyncRealtime({APIURL, closeDelay: () => timer(6000)});
```

This is useful as if the last subscription is closed then the connection will be closed immediately, resulting in multiple opening-closing of the WebSocket connection.

```
// subscribe to query1/variables1 and wait for the first event
await firstValueFrom(connection(config)(query1, variables1));

// here the WebSocket connection is closed without a closeDelay

// subscribe to query2/variable2 and wait for the first event
await firstValueFrom(connection(config)(query2, variables2));
```

#### ```WebSocketCtor```

The WebSocket to use. Useful if there is no global WebSocket object (such as in NodeJS)

```
import WebSocket from "ws":

const connection = appsyncRealtime({APIURL, WebSocketCtor: WebSocket});
```

### Subscription

#### ```getAuthorizationHeaders``` (required)

A function that gets a ```connect``` and a ```data``` arguments and needs to return an object with the authorization headers.

The values depend on the authorization mode and documented [here](https://docs.aws.amazon.com/appsync/latest/devguide/real-time-websocket-client.html#header-parameter-format-based-on-appsync-api-authorization-mode).

Example for API key authorization:

```
const subscription = connection({
  getAuthorizationHeaders: () => ({host: new URL(APIURL).host, "x-api-key": APIKEY})
});
```

Cognito User Pool JWT:

```
// getAccessToken() returns the Cognito Access Token
const subscription = connection({
  getAuthorizationHeaders: async () => ({host: new URL(APIURL).host, Authorization: await getAccessToken()}),
});
```

IAM:

```
import {SignatureV4} from "@aws-sdk/signature-v4";
import {HttpRequest} from "@aws-sdk/protocol-http";
import {defaultProvider} from "@aws-sdk/credential-provider-node";
import {URL} from "url";
import {Hash} from "@aws-sdk/hash-node";

const subscription = connection({
  getAuthorizationHeaders: async (connect, data) => {
    // this is the AppSync API URL and region
    const {APIURL, apiRegion} = process.env;
    
    const url = new URL(APIURL + (connect ? "/connect" : ""));
    const httpRequest = new HttpRequest({
      body: JSON.stringify(connect ? {} : data),
      headers: {
        "content-type": "application/json; charset=UTF-8",
        accept: "application/json, text/javascript",
        "content-encoding": "amz-1.0",
        host: url.hostname,
      },
      hostname: url.hostname,
      method: "POST",
      path: url.pathname,
      protocol: url.protocol,
      query: {},
    });
    
    const signer = new SignatureV4({
      credentials: defaultProvider(),
      service: "appsync",
      region: apiRegion,
      sha256: Hash.bind(null, "sha256"),
    });
    
    const req = await signer.sign(httpRequest);

    return req.headers;
  }
});

```

#### ```opened```

A function that will be called when the ```start_ack``` message is received from AppSync. Useful when you need to make sure the subscription is established before moving on, such as before fetching data from the backend to not lose events.

```
const opened = new Subject();

connection({
  // ...
  opened: () => opened.next(),
})(query, variables).subscribe({
  next: (e) => console.log("Item!", e),
  error: (e) => console.error(e),
});

// wait for the subscription open
await firstValueFrom(opened);
// subscription is live here
```

#### ```subscriptionRetryConfig```

Retry config for the subscription itself. Gets the same arguments as the [connection retry config](#connectionretryconfig)

#### Arguments for the returned function

The subscription returns a function that needs the ```query``` and the ```variables```. These define the GraphQL subscription query.

```
connection(connectionParams)(`subscription MySubscription {
  door {
    open
    last_updated
  }
}`, {}),
```

### The returned observable

* emit an event for every ```data``` event coming for the subscription
* completes when the subscription is completed or the connection is closed
* errors if the subscription or the connection receives an ```error``` event

## Persistent subscription

The library also provides a ```persistentSubscription``` export that is designed to never terminate. It is useful for operations that need to run without termination.

To use it:

```js
import { appsyncRealtime, persistentSubscription } from "appsync-subscription-observable";

const connection = appsyncRealtime({APIURL});

persistentSubscription(connection)({getAuthorizationHeaders})(query, variables)
  .subscribe((e) => console.log("new item", e);
```

The options it supports on top of the subscription:

* closed: a function that is called when the connection is offline. It is an approximation, but can be used to show an offline label
* reopenTimeoutOnError: an Observable factory to define when to retry after an error
* reopenTimeoutOnComplete: an Observable factory to define when to retry after a complete

The obseravable never ends, it only emits events.
