import {
  glob,
  download,
  NodejsLambda,
  runNpmInstall,
  runPackageJsonScript,
  getNodeVersion,
  getSpawnOptions,
  debug,
} from '@vercel/build-utils';
import { dirname, join, relative, sep, parse as parsePath } from 'path';
import type {
  Files,
  Meta,
  Config,
  BuildV3,
  NodeVersion,
  BuildResultV3,
} from '@vercel/build-utils';
import { getRegExpFromMatchers } from './utils';

interface DownloadOptions {
  files: Files;
  entrypoint: string;
  workPath: string;
  config: Config;
  meta: Meta;
}

async function downloadInstallAndBundle({
  files,
  entrypoint,
  workPath,
  config,
  meta,
}: DownloadOptions) {
  const downloadedFiles = await download(files, workPath, meta);
  const entrypointFsDirname = join(workPath, dirname(entrypoint));
  const nodeVersion = await getNodeVersion(
    entrypointFsDirname,
    undefined,
    config,
    meta
  );
  const spawnOpts = getSpawnOptions(meta, nodeVersion);
  await runNpmInstall(entrypointFsDirname, [], spawnOpts, meta, nodeVersion);
  const entrypointPath = downloadedFiles[entrypoint].fsPath;
  return { entrypointPath, entrypointFsDirname, nodeVersion, spawnOpts };
}

function getAWSLambdaHandler(entrypoint: string, config: Config) {
  if (config.awsLambdaHandler) {
    return config.awsLambdaHandler as string;
  }

  if (process.env.NODEJS_AWS_HANDLER_NAME) {
    const { dir, name } = parsePath(entrypoint);
    return `${dir}${dir ? sep : ''}${name}.${
      process.env.NODEJS_AWS_HANDLER_NAME
    }`;
  }

  return '';
}

async function getPreparedFiles(
  workPath: string,
  baseDir: string,
  config: Config
) {
  const preparedFiles: Files = {};

  if (config.includeFiles) {
    const includeFiles =
      typeof config.includeFiles === 'string'
        ? [config.includeFiles]
        : config.includeFiles;

    for (const pattern of includeFiles) {
      const files = await glob(pattern, workPath);
      await Promise.all(
        Object.values(files).map(async (entry) => {
          const { fsPath } = entry;
          const relPath = relative(baseDir, fsPath);
          preparedFiles[relPath] = entry;
        })
      );
    }
  }

  const distFiles = await glob('dist/**/*', workPath);

  Object.values(distFiles).forEach(async (entry) => {
    const { fsPath } = entry;
    const relPath = relative(baseDir, fsPath);
    preparedFiles[relPath] = entry;
  });

  return {
    preparedFiles,
  };
}

export const build: BuildV3 = async ({
  files,
  entrypoint,
  workPath,
  repoRootPath,
  config = {},
  meta = {},
}) => {
  const baseDir = repoRootPath || workPath;
  const awsLambdaHandler = getAWSLambdaHandler(entrypoint, config);

  const { entrypointPath, entrypointFsDirname, nodeVersion, spawnOpts } =
    await downloadInstallAndBundle({
      files,
      entrypoint,
      workPath,
      config,
      meta,
    });

  await runPackageJsonScript(entrypointFsDirname, ['build'], spawnOpts);

  const isMiddleware = config.middleware === true;

  // Will output an `EdgeFunction` for when `config.middleware = true`
  // (i.e. for root-level "middleware" file) or if source code contains:
  // `export const config = { runtime: 'edge' }`
  let isEdgeFunction = isMiddleware;

  debug('Tracing input files...');
  const traceTime = Date.now();
  const { preparedFiles } = await getPreparedFiles(workPath, baseDir, config);

  debug(`Trace complete [${Date.now() - traceTime}ms]`);

  let routes: BuildResultV3['routes'];
  let output: BuildResultV3['output'] | undefined;

  const handler = relative(baseDir, 'dist/main.js');

  // Add a `route` for Middleware
  if (isMiddleware) {
    if (!isEdgeFunction) {
      // Root-level middleware file can not have `export const config = { runtime: 'nodejs' }`
      throw new Error(
        `Middleware file can not be a Node.js Serverless Function`
      );
    }

    // Middleware is a catch-all for all paths unless a `matcher` property is defined
    const src = getRegExpFromMatchers(config.matcher);

    const middlewareRawSrc: string[] = [];
    if (config?.matcher) {
      if (Array.isArray(config.matcher)) {
        middlewareRawSrc.push(...config.matcher);
      } else {
        middlewareRawSrc.push(config.matcher as string);
      }
    }

    routes = [
      {
        src,
        middlewareRawSrc,
        middlewarePath: entrypoint,
        continue: true,
        override: true,
      },
    ];
  }

  // "nodejs" runtime is the default
  const shouldAddHelpers = !(
    config.helpers === false || process.env.NODEJS_HELPERS === '0'
  );

  const supportsResponseStreaming = config?.supportsResponseStreaming === true;

  output = new NodejsLambda({
    files: preparedFiles,
    handler,
    runtime: nodeVersion.runtime,
    shouldAddHelpers,
    shouldAddSourcemapSupport: false,
    awsLambdaHandler,
    supportsResponseStreaming,
  });

  return { routes, output };
};
