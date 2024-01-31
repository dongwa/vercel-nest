# Vercel-nest

Vercel builder for Nestjs

Help you to deploy [Nestjs](https://docs.nestjs.com/) application on [Vercel](https://vercel.com) in SSR mode

# Usage

## 1. Add build command to `package.json`

```json
{
  "scripts": {
    "build": "nest build"
  }
}
```

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

## Support Swagger-ui

```json
{
  "builds": [
    {
      "src": "package.json",
      "use": "vercel-nest",
      "config": {
        // change "docs" to your 'path' of SwaggerModule.setup(path, app, document);
        "swagger": "docs"
      }
    }
  ]
}
```

# How to work

1. Using the `npm run build` command to build the project. You need to define the build command in your `package.json`,
   for example:

```json
{
  "scripts": {
    "build": "nest build"
  }
}
```

2. Using `dist/main.js` as the entry point of the program, and retrieve all its dependency files to build the Vercel Lambda function, named `index`.

3. Define a `routes` to forward all requests to `index`.
