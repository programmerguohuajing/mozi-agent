/**
 * Metro 配置：Expo web + RN 统一打包。
 * monorepo 内解析 @mozi/protocol（纯 TS/JS，无原生模块，可直接经 metro 打包）。
 */
const { getDefaultConfig } = require('@expo/metro-config');

const config = getDefaultConfig(__dirname);

// monorepo：允许 metro 解析 workspace 根之外的依赖（pnpm 软链）。
config.resolver.nodeModulesPaths = [
  ...config.resolver.nodeModulesPaths,
  require('path').resolve(__dirname, '../../node_modules'),
];
config.watchFolders = [require('path').resolve(__dirname, '../..')];

module.exports = config;