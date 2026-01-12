# NestJS Nx Monorepo with Global Libs

This is an Nx monorepo setup with NestJS and a global `libs` folder for shared code across applications.

## Structure

```
cp-ai/
├── apps/                      # Applications folder
│   ├── api/                  # NestJS API application
│   │   └── src/
│   │       └── app/
│   └── api-e2e/              # E2E tests for the API
│       └── src/
├── libs/                      # Shared libraries (global)
│   └── common/               # Common shared library
│       └── src/
│           ├── index.ts
│           └── lib/
│               ├── common.module.ts
│               └── common.service.ts
├── nx.json                   # Nx configuration
├── package.json              # Root package.json
└── tsconfig.base.json        # Base TypeScript configuration
```

## Key Features

### 1. Global Libs Folder

- All shared libraries are located in the `libs/` directory
- Libraries can be used by any application in the monorepo
- Libraries are configured with custom import paths (e.g., `@org/common`)

### 2. Path Mapping

Libraries are automatically configured in `tsconfig.base.json` with path mappings, allowing clean imports:

```typescript
// Import from shared library
import { CommonService, OrgCommonModule } from '@org/common';
```

### 3. Buildable Libraries

The shared libraries are configured as buildable, which means:

- They can be built independently
- Nx caches the build results
- Applications only rebuild when library changes occur
- Faster incremental builds

## Getting Started

### Prerequisites

- Node.js (v18+ recommended)
- npm or yarn

### Installation

```bash
# Install dependencies
npm install
```

### Available Commands

#### Build

```bash
# Build the API application (automatically builds dependencies)
nx build api

# Build a specific library
nx build @org/common

# Build all projects
nx run-many -t build
```

#### Serve/Run

```bash
# Serve the API in development mode
nx serve api

# The API will typically run on http://localhost:3000
```

#### Test

```bash
# Run tests for the API
nx test api

# Run tests for a library
nx test @org/common

# Run all tests
nx run-many -t test
```

#### Lint

```bash
# Lint the API
nx lint api

# Lint a library
nx lint @org/common

# Lint all projects
nx run-many -t lint
```

## Creating New Projects

### Create a New NestJS Application

```bash
nx g @nx/nest:application apps/my-app --name=my-app --linter=eslint --unitTestRunner=jest
```

### Create a New Shared Library

```bash
# Create a buildable library
nx g @nx/nest:library libs/my-lib --buildable --importPath=@org/my-lib

# Create a publishable library
nx g @nx/nest:library libs/my-lib --publishable --importPath=@org/my-lib
```

### Create a Service in a Library

```bash
nx g @nx/nest:service my-service --project=@org/my-lib
```

### Create a Controller in a Library

```bash
nx g @nx/nest:controller my-controller --project=@org/my-lib
```

## Using Shared Libraries

### 1. Export from the Library

In `libs/common/src/index.ts`:

```typescript
export * from './lib/common.module';
export * from './lib/common.service';
```

### 2. Import in Your Application

In `apps/api/src/app/app.module.ts`:

```typescript
import { Module } from '@nestjs/common';
import { OrgCommonModule } from '@org/common';

@Module({
  imports: [OrgCommonModule],
  // ...
})
export class AppModule {}
```

### 3. Use the Shared Service

In `apps/api/src/app/app.service.ts`:

```typescript
import { Injectable } from '@nestjs/common';
import { CommonService } from '@org/common';

@Injectable()
export class AppService {
  constructor(private readonly commonService: CommonService) {}

  getData() {
    return this.commonService.getWelcomeMessage();
  }
}
```

## Project Graph

View the dependency graph of your projects:

```bash
nx graph
```

This will open a visual representation showing how your applications and libraries are connected.

## Affected Commands

Nx can determine which projects are affected by your changes:

```bash
# Build only affected projects
nx affected -t build

# Test only affected projects
nx affected -t test

# Lint only affected projects
nx affected -t lint
```

## Workspace Synchronization

If you see an "out of sync" warning, run:

```bash
nx sync
```

This ensures TypeScript project references are up to date.

## Best Practices

1. **Keep Libraries Focused**: Each library should have a single, well-defined purpose
2. **Use Barrel Exports**: Export all public APIs through `index.ts`
3. **Leverage Nx Cache**: Nx caches build outputs for faster subsequent builds
4. **Run Affected Commands**: Use `nx affected` to run tasks only on changed projects
5. **Document Dependencies**: Keep the dependency graph clean and documented

## Library Types

### Buildable Libraries

- Independent build process
- Cached by Nx
- Faster incremental builds
- Good for shared code between apps

### Publishable Libraries

- Can be published to npm
- Includes all features of buildable libraries
- Requires `--importPath` flag

## TypeScript Configuration

The monorepo uses TypeScript project references for better type-checking and build performance:

- `tsconfig.base.json`: Base configuration for the entire workspace
- `tsconfig.json`: Root TypeScript configuration
- `apps/*/tsconfig.json`: Application-specific configuration
- `libs/*/tsconfig.json`: Library-specific configuration

## Troubleshooting

### Build Errors

If you encounter build errors:

1. Run `nx reset` to clear the cache
2. Run `nx sync` to synchronize project references
3. Delete `node_modules` and reinstall dependencies

### Import Errors

If imports are not resolving:

1. Check `tsconfig.base.json` for correct path mappings
2. Ensure the library is properly exported in `index.ts`
3. Run `nx sync` to update project references

## Additional Resources

- [Nx Documentation](https://nx.dev)
- [NestJS Documentation](https://docs.nestjs.com)
- [Nx NestJS Plugin](https://nx.dev/nx-api/nest)
