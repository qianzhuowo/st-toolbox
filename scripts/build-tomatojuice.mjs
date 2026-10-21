import { build } from 'esbuild';
await build({ entryPoints: ['features/tomatojuice/client/index.ts'], outfile: 'features/tomatojuice/runtime.js', bundle: true, format: 'esm', platform: 'browser', target: ['es2022'], external: ['/script.js'], legalComments: 'inline' });
console.log('Built tomatojuice/runtime.js');
