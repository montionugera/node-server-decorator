


# Server Decorator

A TypeScript library for server-side decorators.

## Installation

To install the package, use npm or yarn:

```sh
npm install server-decorator
```

or

```sh
yarn add server-decorator
```

## Usage

### Importing the Decorators

```typescript
import { cache, tracking } from 'server-decorator';
```

### Example

#### Cache Decorator

```typescript
import { cache } from 'server-decorator';

class ExampleService {
  @cache()
  getData() {
    // Your implementation here
  }
}
```

#### Tracking Decorator

```typescript
import { tracking } from 'server-decorator';

class ExampleService {
  @tracking()
  trackData() {
    // Your implementation here
  }
}
```
### EmitOnSuccess Decorator

The `EmitOnSuccess` decorator emits an event whenever the decorated method completes successfully.

```ts

import { EmitOnSuccess } from 'server-decorator';

class ExampleService {
    @EmitOnSuccess()
    syncMethod(data: string) {
        return `Hello, ${data}`;
    }

    @EmitOnSuccess()
    async asyncMethod(data: string) {
        return Promise.resolve(`Hello, ${data}`);
    }

    @EmitOnSuccess({ transform: (res) => ({ greeting: res }) })
    transformedMethod(data: string) {
        return `Hello, ${data}`;
    }
}
```
How It Works
The decorator emits an event named ClassName.methodName when the method completes successfully. If the method returns a promise, the event is emitted after the promise resolves.

or

```sh
yarn run test
```

## Publishing

To publish the package, use the following command:

```sh
npm run publish-package
```

or

```sh
yarn run publish-package
```

Make sure you have configured your npm token in the `.npmrc` file.

## License

This project is licensed under the ISC License.
