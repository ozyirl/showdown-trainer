# Quick Start Guide

## 🚀 Get Started in 3 Steps

### 1. Install Dependencies
```bash
npm install
```

### 2. Build the Project
```bash
npm run build
# or
nx build api
```

### 3. Start the Development Server
```bash
npm start
# or
nx serve api
```

The API will be available at: `http://localhost:3000`

## 📁 Workspace Structure

```
cp-ai/
├── apps/
│   ├── api/              # NestJS API application
│   └── api-e2e/          # E2E tests
├── libs/
│   ├── common/           # Shared common library
│   └── utils/            # Shared utilities library
├── package.json
└── nx.json
```

## 🔧 Common Commands

### Development
```bash
npm start                 # Start API in dev mode
npm run build            # Build API
npm test                 # Run API tests
npm run lint             # Lint API
```

### Nx Commands
```bash
nx serve api             # Start API
nx build api             # Build API
nx test api              # Test API
nx lint api              # Lint API
nx graph                 # View project graph
```

### Library Commands
```bash
# Build a specific library
nx build @org/common
nx build @org/utils

# Test a library
nx test @org/common

# Generate a new library
nx g @nx/nest:library libs/my-lib --buildable --importPath=@org/my-lib
```

### Run Multiple Projects
```bash
# Build all projects
nx run-many -t build

# Test all projects
nx run-many -t test

# Lint all projects
nx run-many -t lint
```

### Affected Commands
```bash
# Build only what changed
nx affected -t build

# Test only what changed
nx affected -t test

# Lint only what changed
nx affected -t lint
```

## 📦 Using Shared Libraries

### Import in Your App
```typescript
// apps/api/src/app/app.module.ts
import { OrgCommonModule } from '@org/common';

@Module({
  imports: [OrgCommonModule],
  // ...
})
export class AppModule {}
```

### Use Shared Services
```typescript
// apps/api/src/app/app.service.ts
import { CommonService } from '@org/common';

@Injectable()
export class AppService {
  constructor(private readonly commonService: CommonService) {}
  
  getData() {
    return this.commonService.getWelcomeMessage();
  }
}
```

## 🎯 Testing the Setup

Test that the shared library integration works:

```bash
# Build the project
npm run build

# The output should show:
# ✓ nx run @org/common:build
# ✓ nx run api:build
```

## 📊 View Project Graph

See how your projects are connected:

```bash
npm run graph
# or
nx graph
```

This will open a visual representation in your browser.

## 🆘 Troubleshooting

### Workspace out of sync
```bash
nx sync
```

### Clear cache
```bash
nx reset
```

### Reinstall dependencies
```bash
rm -rf node_modules package-lock.json
npm install
```

## 📚 Next Steps

1. Read the full documentation: `NESTJS_MONOREPO_SETUP.md`
2. Create your first shared library
3. Add more NestJS applications
4. Set up CI/CD pipelines

## 🔗 Resources

- [Nx Documentation](https://nx.dev)
- [NestJS Documentation](https://docs.nestjs.com)
- [Nx NestJS Plugin](https://nx.dev/nx-api/nest)

