# AppSync subscription implemented as an RxJs observable

This library provides an optimized way to subscribe to AppSync updates and get a stream of events. It aims to hide the connection management part and behaves as each subscription has its own connection.

It handles:

* Reuses the same connection for multiple subscriptions
* The authorization headers used for the connection are the same as the subscription that opened that connection. This makes it easy to refresh authorization for reconnections.
* Provides an ```opened``` handler that is called when AppSync sends the ```start_ack``` message. This makes it possible to reliably know when events are expected
* Allows defining the retry parameters for both the connection and the subscription

## Usage

Initialize the connection object:

```js
import { appsyncRealtime, persistentSubscription } from "appsync-subscription-observable";

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

Connection:

* APIURL: AppSync GraphQL endpoint (required)
* connectionRetryConfig: base, cap, maxAttempts, timeout: connection retry parameters
* closeDelay: an observable factory that can delay closing the connection when all subscription are unsubscribed
* WebSocketCtor: the WebSocket to use

Subscription:

* getAuthorizationHeaders: a function that gets a ```connect``` and a ```data``` arguments and needs to return an object with the authorization headers (required)
* opened: a function that will be called when the ```start_ack``` message is received from AppSync
* subscriptionRetryConfig: base, cap, maxAttempts, timeout: subscription retry parameters
* query, variables: the subscription query

The observable will:

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
