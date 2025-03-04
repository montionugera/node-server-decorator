


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

## Scripts

- `build`: Compiles the TypeScript code.
- `test`: Runs the tests using Jest.
- `publish-package`: Publishes the package to npm.

## Running Tests

To run the tests, use the following command:

```sh
npm run test
```

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
