import {
  glob,
  download,
  NodejsLambda,
  runNpmInstall,
  runPackageJsonScript,
  getNodeVersion,
  getSpawnOptions,
  isSymbolicLink,
  FileFsRef,
  FileBlob,
} from '@vercel/build-utils';
import {
  dirname,
  join,
  relative,
  sep,
  parse as parsePath,
  resolve,
} from 'path';
import type {
  Files,
  Meta,
  Config,
  BuildV3,
  BuildResultV3,
  File,
  BuildV2,
  BuildResultV2,
  BuildResultV2Typical,
} from '@vercel/build-utils';
import { nodeFileTrace } from '@vercel/nft';
import nftResolveDependency from '@vercel/nft/out/resolve-dependency';
import { readFileSync, lstatSync, readlinkSync, statSync } from 'fs';
import { isErrnoException } from '@vercel/error-utils';
// nestjs default entry
const nestEntry = 'dist/main.js';
const nestLambdaName = 'index';
interface DownloadOptions {
  files: Files;
  entrypoint: string;
  workPath: string;
  config: Config;
  meta: Meta;
  baseDir: string;
}

async function downloadInstallAndBundle({
  files,
  entrypoint,
  workPath,
  config,
  meta,
  baseDir,
}: DownloadOptions) {
  const downloadedFiles = await download(files, workPath, meta);
  const nodeVersion = await getNodeVersion(baseDir, undefined, config, meta);
  const spawnOpts = getSpawnOptions(meta, nodeVersion);
  await runNpmInstall(baseDir, [], spawnOpts, meta, nodeVersion);
  const entrypointPath = downloadedFiles[entrypoint].fsPath;
  return { entrypointPath, nodeVersion, spawnOpts };
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
  const inputFiles = new Set<string>([join(baseDir, nestEntry)]);

  const sourceCache = new Map<string, string | Buffer | null>();
  const fsCache = new Map<string, File>();

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

  const { fileList, warnings } = await nodeFileTrace([...inputFiles], {
    base: baseDir,
    processCwd: workPath,
    mixedModules: true,
    resolve(id, parent, job, cjsResolve) {
      const normalizedWasmImports = id.replace(/\.wasm\?module$/i, '.wasm');
      return nftResolveDependency(
        normalizedWasmImports,
        parent,
        job,
        cjsResolve
      );
    },
    ignore: config.excludeFiles,
    async readFile(fsPath) {
      const relPath = relative(baseDir, fsPath);

      // If this file has already been read then return from the cache
      const cached = sourceCache.get(relPath);
      if (typeof cached !== 'undefined') return cached;

      try {
        let entry: File | undefined;
        let source: string | Buffer = readFileSync(fsPath);

        const { mode } = lstatSync(fsPath);
        if (isSymbolicLink(mode)) {
          entry = new FileFsRef({ fsPath, mode });
        }

        if (!entry) {
          entry = new FileBlob({ data: source, mode });
        }
        fsCache.set(relPath, entry);
        sourceCache.set(relPath, source);
        return source;
      } catch (error: unknown) {
        if (
          isErrnoException(error) &&
          (error.code === 'ENOENT' || error.code === 'EISDIR')
        ) {
          // `null` represents a not found
          sourceCache.set(relPath, null);
          return null;
        }
        throw error;
      }
    },
  });

  for (const warning of warnings) {
    console.log(`Warning from trace: ${warning.message}`);
  }
  for (const path of fileList) {
    let entry = fsCache.get(path);
    if (!entry) {
      const fsPath = resolve(baseDir, path);
      const { mode } = lstatSync(fsPath);
      if (isSymbolicLink(mode)) {
        entry = new FileFsRef({ fsPath, mode });
      } else {
        const source = readFileSync(fsPath);
        entry = new FileBlob({ data: source, mode });
      }
    }
    if (isSymbolicLink(entry.mode) && entry.type === 'FileFsRef') {
      // ensure the symlink target is added to the file list
      const symlinkTarget = relative(
        baseDir,
        resolve(dirname(entry.fsPath), readlinkSync(entry.fsPath))
      );
      if (
        !symlinkTarget.startsWith('..' + sep) &&
        !fileList.has(symlinkTarget)
      ) {
        const stats = statSync(resolve(baseDir, symlinkTarget));
        if (stats.isFile()) {
          fileList.add(symlinkTarget);
        }
      }
    }

    preparedFiles[path] = entry;
  }

  return {
    preparedFiles,
  };
}

export const build: BuildV2 = async (options) => {
  const { name, version } = await import('../package.json');
  console.log(`using ${name}@${version}`);
  const {
    files,
    entrypoint,
    workPath,
    repoRootPath,
    config = {},
    meta = {},
  } = options;
  const baseDir = repoRootPath || workPath;
  const awsLambdaHandler = getAWSLambdaHandler(entrypoint, config);
  console.log('download and install...');
  const { nodeVersion, spawnOpts } = await downloadInstallAndBundle({
    files,
    entrypoint,
    workPath,
    config,
    meta,
    baseDir,
  });

  console.log('run packageJson build script...');
  await runPackageJsonScript(baseDir, ['build'], spawnOpts);

  const isMiddleware = config.middleware === true;

  // Will output an `EdgeFunction` for when `config.middleware = true`
  // (i.e. for root-level "middleware" file) or if source code contains:
  // `export const config = { runtime: 'edge' }`
  let isEdgeFunction = isMiddleware;

  console.log('Tracing input files...');
  const traceTime = Date.now();
  const { preparedFiles } = await getPreparedFiles(workPath, baseDir, config);

  console.log(`Trace complete [${Date.now() - traceTime}ms]`);

  let routes: BuildResultV2Typical['routes'];
  let output: BuildResultV2Typical['output'] | undefined;

  const handler = relative(baseDir, nestEntry);
  console.log('handler', handler);

  // @TODO：support config routes and static routes
  routes = [
    {
      src: '/(.*)',
      dest: `/${nestLambdaName}`,
    },
  ];

  // "nodejs" runtime is the default
  const shouldAddHelpers = !(
    config.helpers === false || process.env.NODEJS_HELPERS === '0'
  );

  const supportsResponseStreaming = config?.supportsResponseStreaming === true;

  output = {
    [nestLambdaName]: new NodejsLambda({
      files: preparedFiles,
      handler,
      runtime: nodeVersion.runtime,
      shouldAddHelpers,
      shouldAddSourcemapSupport: false,
      awsLambdaHandler,
      supportsResponseStreaming,
    }),
  };
  return { routes, output };
};
