# Vercel-nest

Vercel builder for Nestjs

Help you to deploy [Nestjs](https://docs.nestjs.com/) application on [Vercel](https://vercel.com) in SSR mode

# Usage

## 1. Configure `vercel-nest` as builder in `vercel.json`

### Add a `vercel.json` file to your project root path

```json
{
  "builds": [
    {
      "src": "package.json",
      "use": "vercel-nest"
    }
  ]
}
```
