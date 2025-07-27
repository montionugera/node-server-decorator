#!/bin/bash

# Create project directory
mkdir node-server-decorator
cd node-server-decorator

# Initialize npm
npm init -y

# Install dev dependencies
npm install typescript @types/node --save-dev

# Create tsconfig.json
cat <<EOF > tsconfig.json
{
  "compilerOptions": {
    "target": "ES2017",
    "module": "CommonJS",
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true,
    "outDir": "./dist",
    "strict": true
  },
  "include": ["src/**/*"]
}
EOF

# Make source directories
mkdir -p src/decorators

# tracking.ts
cat <<EOF > src/decorators/tracking.ts
export function tracking(target: any, propertyKey: string, descriptor: PropertyDescriptor) {
  const originalMethod = descriptor.value;
  descriptor.value = async function (...args: any[]) {
    const start = Date.now();
    let result: any;
    let isError = false;
    try {
      result = await originalMethod.apply(this, args);
    } catch (error) {
      isError = true;
      throw error;
    } finally {
      const latency = Date.now() - start;
      const key = \`\${target.constructor.name}.\${propertyKey}\`;
      console.log(\`[Tracking] \${key} - Latency: \${latency}ms, Error: \${isError}\`);
      if (result && typeof result === 'object') {
        result.isError = isError;
      }
    }
    return result;
  };
  return descriptor;
}
EOF

# cache.ts
cat <<EOF > src/decorators/cache.ts
export function cache(cacheAdapter: any, TTL: number) {
  return function (target: any, propertyKey: string, descriptor: PropertyDescriptor) {
    const originalMethod = descriptor.value;
    descriptor.value = async function (...args: any[]) {
      const key = \`\${target.constructor.name}.\${propertyKey}.\${args.join('.')}\`;
      const cached = await cacheAdapter.get(key);
      if (cached) {
        console.log(\`[Cache] Hit for key: \${key}\`);
        return cached;
      }
      const result = await originalMethod.apply(this, args);
      await cacheAdapter.set(key, result, TTL);
      console.log(\`[Cache] Set for key: \${key} with TTL: \${TTL}\`);
      return result;
    };
    return descriptor;
  };
}
EOF

# index.ts
cat <<EOF > src/index.ts
export { tracking } from './decorators/tracking';
export { cache } from './decorators/cache';
EOF

# Add build script to package.json
npm set-script build "tsc"

echo "Project setup complete. Run 'npm run build' to compile."
