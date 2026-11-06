'use strict';

// Isolated factory fixture build. Upstream package/config/source files stay intact.
const path = require('node:path');
process.env.BUILD_MODE = 'node';
process.env.NODE_ENV = 'development';
const root = path.resolve(__dirname, '..');
const vmRoot = path.resolve(root, '..', 'scratch-vm');
const modules = path.join(root, 'node_modules');
const vmEntry = path.join(vmRoot, 'src', 'index.js');
const renderEntry = path.join(modules, '.bun', 'scratch-render@github+02engine+scratch-render+6762ea8+ffa7372a05f3f79d', 'node_modules', 'scratch-render', 'src', 'index.js');
const audioEntry = path.join(modules, '.bun', 'scratch-audio@github+02engine+scratch-audio+84bd718', 'node_modules', 'scratch-audio', 'src', 'index.js');
const svgRoot = path.join(modules, '.bun', '@turbowarp+scratch-svg-renderer@github+Deep-sea-lab+scratch-svg-renderer+587df0a+6ece098b1cdca7ab', 'node_modules', '@turbowarp', 'scratch-svg-renderer');
const upstream = require(path.join(root, 'webpack.config.js'));
const babelPreset = require.resolve('@babel/preset-env', {paths: [root]});
const sourceRoots = [vmRoot, path.dirname(renderEntry), path.dirname(audioEntry), svgRoot];
const babelRule = {
  test: /\.jsx?$/,
  include: sourceRoots,
  loader: 'babel-loader',
  options: {babelrc: false, configFile: false, presets: [babelPreset]}
};
const nodeAssetRules = [
  {test: /\.(mp3|wav)$/i, use: [{loader: 'url-loader', options: {esModule: false}}]},
  {test: /\.css$/i, use: ['style-loader', 'css-loader']}
];

module.exports = upstream.map(config => {
  const existingRules = config.module?.rules || [];
  const rules = [...(config.target === 'node' ? [babelRule, ...nodeAssetRules] : []),
    ...existingRules.map(rule => rule.loader === 'babel-loader'
      ? {...rule, include: [...(rule.include || []), ...sourceRoots],
        options: {...rule.options, babelrc: false, configFile: false, presets: [babelPreset]}}
      : rule)];
  return {
    ...config,
    context: root,
    ...(config.target === 'node' ? {externals: {...config.externals,
      'javascript-obfuscator': 'commonjs javascript-obfuscator',
      jsdom: 'commonjs jsdom'}} : {}),
    resolve: {
      ...config.resolve,
      modules: [modules, 'node_modules'],
      alias: {
        ...config.resolve?.alias,
        'scratch-vm$': vmEntry,
        'scratch-render$': renderEntry,
        'scratch-audio$': audioEntry,
        '@turbowarp/scratch-svg-renderer$': path.join(svgRoot, 'src', 'index.js')
      }
    },
    resolveLoader: {
      ...config.resolveLoader,
      modules: [path.join(root, 'src', 'build', 'inline-worker-loader'), modules, 'node_modules']
    },
    module: {...config.module, rules}
  };
});
