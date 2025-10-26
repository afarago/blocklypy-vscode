//@ts-check

'use strict';

const webpack = require('webpack');
const path = require('path');
const glob = require('glob');
const CopyWebpackPlugin = require('copy-webpack-plugin');
const MonacoWebpackPlugin = require('monaco-editor-webpack-plugin');

//@ts-check
/** @typedef {import('webpack').Configuration} WebpackConfig **/

const isDevelopment = process.env.NODE_ENV?.trim() === 'development';
const { platform } = require('node:process');
// console.log(`isDevelopment: ${isDevelopment}, platform: ${platform}`);

/** @type WebpackConfig */
const extensionUniversalConfig = {
    target: 'node',
    mode: 'none',
    entry: {
        'extension-universal': './src/extension-universal.ts',
    },
    output: {
        filename: '[name].js',
        path: path.resolve(__dirname, 'dist'),
        libraryTarget: 'commonjs2',
    },
    externals: [
        {
            vscode: 'commonjs vscode',
        },
        '@pybricks/mpy-cross-v6',
        ...(['win32', 'darwin'].includes(platform)
            ? ['@stoprocent/bluetooth-hci-socket']
            : []),
        'ws',
    ],
    resolve: {
        extensions: ['.ts', '.js', '.json'],
    },
    module: {
        rules: [
            {
                test: /\.ts$/,
                exclude: [/node_modules/, path.resolve(__dirname, 'src/views/webview')],
                use: [
                    {
                        loader: 'ts-loader',
                    },
                ],
            },
        ],
    },
    // devtool: 'nosources-source-map',
    devtool: isDevelopment ? 'source-map' : undefined,
    infrastructureLogging: {
        level: 'log',
    },
    plugins: [
        new CopyWebpackPlugin({
            patterns: [
                {
                    from: path.resolve(
                        __dirname,
                        'node_modules/@pybricks/mpy-cross-v6/build/mpy-cross-v6.wasm',
                    ),
                    to: path.resolve(__dirname, 'dist'),
                },
                // {
                //     from: path.resolve(__dirname, 'src/assets'),
                //     to: path.resolve(__dirname, 'dist/assets'),
                // },
            ],
        }),
    ],
    optimization: {
        minimize: !isDevelopment,
        runtimeChunk: false,
        splitChunks: false,
    },
};

/** @type WebpackConfig */
const extensionWebConfig = {
    target: 'webworker',
    mode: isDevelopment ? 'development' : 'production',
    entry: {
        'extension-web': './src/extension-web.ts',
    },
    output: {
        filename: '[name].js',
        path: path.resolve(__dirname, 'dist/web'),
        libraryTarget: 'commonjs2',
        devtoolModuleFilenameTemplate: '../[resource-path]',
    },
    externals: {
        vscode: 'commonjs vscode',
    },
    resolve: {
        mainFields: ['browser', 'module', 'main'],
        extensions: ['.ts', '.js', '.json'],
        fallback: {
            assert: require.resolve('assert'),
            path: require.resolve('path-browserify'),
            url: require.resolve('url'),
            'crc-32': false,
            fs: false,
            crypto: false,
            os: false,
            stream: false,
            util: false,
        },
        alias: {
            // ensure fully-specified imports like "process/browser" resolve to the actual file
            'process/browser': require.resolve('process/browser'),
            // make "process" also point to the browser shim (helps some packages)
            process: require.resolve('process/browser'),
        },
    },
    module: {
        rules: [
            {
                test: /\.ts$/,
                exclude: /node_modules/,
                use: [
                    {
                        loader: 'ts-loader',
                        options: {
                            configFile: 'tsconfig.web.json',
                        },
                    },
                ],
            },
        ],
    },
    devtool: isDevelopment ? 'source-map' : 'hidden-source-map',
    infrastructureLogging: {
        level: 'log',
    },
    plugins: [
        new webpack.ProvidePlugin({
            process: 'process/browser', // provide a shim for the global `process` variable
            Buffer: ['buffer', 'Buffer'], // provide a shim for the global `Buffer` variable
        }),
        new CopyWebpackPlugin({
            patterns: [
                {
                    from: path.resolve(
                        __dirname,
                        'node_modules/@pybricks/mpy-cross-v6/build/mpy-cross-v6.wasm',
                    ),
                    to: path.resolve(__dirname, 'dist/web'),
                },
                // {
                //     from: path.resolve(__dirname, 'src/assets'),
                //     to: path.resolve(__dirname, 'dist/web/assets'),
                // },
            ],
        }),
        // {
        //     apply(compiler) {
        //         compiler.hooks.normalModuleFactory.tap(
        //             'LogModuleInclusionPlugin',
        //             (nmf) => {
        //                 // before resolve -> shows import requests
        //                 nmf.hooks.beforeResolve.tap(
        //                     'LogModuleInclusionPlugin',
        //                     (result) => {
        //                         if (!result) return;
        //                         const req = String(result.request || '');
        //                         console.log(
        //                             '[webpack][resolve request]',
        //                             req,
        //                             'from',
        //                             result.context,
        //                         );
        //                         // optionally print stack to see importer (heavy)
        //                         // console.trace();
        //                     },
        //                 );

        //                 // after resolve -> shows resolved resource path
        //                 nmf.hooks.afterResolve.tap(
        //                     'LogModuleInclusionPlugin',
        //                     (resolveResult) => {
        //                         if (!resolveResult) return;
        //                         const res = String(
        //                             (resolveResult.createData &&
        //                                 resolveResult.createData.resource) ||
        //                                 '',
        //                         );
        //                         console.log('[webpack][resolved resource]', res);
        //                     },
        //                 );
        //             },
        //         );

        //         // during compilation -> shows modules being built
        //         compiler.hooks.compilation.tap(
        //             'LogModuleInclusionPlugin',
        //             (compilation) => {
        //                 compilation.hooks.buildModule.tap(
        //                     'LogModuleInclusionPlugin',
        //                     (module) => {
        //                         if (module && typeof module.identifier === 'function') {
        //                             console.log(
        //                                 '[webpack][buildModule]',
        //                                 module.identifier(),
        //                             );
        //                         }
        //                     },
        //                 );
        //             },
        //         );
        //     },
        // },
    ],
    optimization: {
        minimize: !isDevelopment,
    },
    performance: {
        hints: false,
    },
};

const webviewEntryFiles = glob
    .sync(path.resolve(__dirname, 'src/views/webview/*.ts'))
    .filter((f) => !f.endsWith('.d.ts'));
webviewEntryFiles.push(path.resolve(__dirname, 'src/views/webview/monaco-vendor.ts'));

// !! TODO: webview is needed for dist and dist/web as well
const webviewConfig = {
    target: 'web',
    mode: 'none',
    entry: Object.fromEntries(
        webviewEntryFiles.map((file) => {
            const name = path.basename(file, path.extname(file));
            return [name, file];
        }),
    ),
    output: {
        filename: '[name].js',
        path: path.resolve(__dirname, 'dist/webview'),
    },
    resolve: {
        extensions: ['.ts', '.js', '.json'],
    },
    module: {
        rules: [
            {
                test: /\.ts$/,
                use: [
                    {
                        loader: 'ts-loader',
                        options: {
                            configFile: path.resolve(__dirname, 'tsconfig.web.json'),
                        },
                    },
                ],
                exclude: /node_modules/,
            },
            { test: /\.css$/, use: ['style-loader', 'css-loader'] },
        ],
    },
    plugins: [
        new MonacoWebpackPlugin({
            languages: ['python', 'less'],
            globalAPI: true,
            filename: 'monaco-vendor.worker.js',
            // filename: 'monaco.[name].worker.js',
        }),
    ],
    optimization: {
        minimize: !isDevelopment,
        runtimeChunk: false,
        splitChunks: {
            // chunks: 'all',
            cacheGroups: {
                monaco: {
                    test: /[\\/]node_modules[\\/]monaco-editor[\\/]/,
                    name: 'monaco-vendor',
                    chunks: 'all',
                    enforce: true,
                    priority: 100, // Use very high priority
                    reuseExistingChunk: true,
                },
                // This additional rule can help catch more monaco modules
                monacoLang: {
                    test: /monaco-(editor|languages)/,
                    name: 'monaco-vendor',
                    chunks: 'all',
                    enforce: true,
                    priority: 90,
                },
            },
        },
    },
    devtool: isDevelopment ? 'source-map' : undefined,
    infrastructureLogging: {
        level: 'log',
    },
    performance: isDevelopment
        ? {
              maxAssetSize: 512000, // Increase asset size limit to 500 KB
              maxEntrypointSize: 1024000, // Increase entry point size limit to 1 MB
              hints: false, // Disable performance hints during development
          }
        : undefined,
};

module.exports = [
    extensionUniversalConfig,
    // extensionWebConfig,
    webviewConfig,
];
