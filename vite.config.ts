import react from '@vitejs/plugin-react';
import { cloudflare } from '@cloudflare/vite-plugin';
import { defineConfig } from 'vite';
import packageJson from './package.json';

const useRemoteBindings = process.env.CF_REMOTE_BINDINGS === '1';
const githubRepository = process.env.GITHUB_REPOSITORY || 'huangxida/cf-zone';
const tagName = process.env.GITHUB_REF?.startsWith('refs/tags/')
	? process.env.GITHUB_REF_NAME || process.env.GITHUB_REF.replace('refs/tags/', '')
	: '';
const appVersion = process.env.APP_VERSION || tagName || packageJson.version;
const appReleaseUrl = process.env.APP_RELEASE_URL
	|| (tagName
		? `https://github.com/${githubRepository}/releases/tag/${appVersion}`
		: `https://github.com/${githubRepository}/releases`);

export default defineConfig({
	define: {
		__APP_VERSION__: JSON.stringify(appVersion),
		__APP_RELEASE_URL__: JSON.stringify(appReleaseUrl),
	},
	plugins: [
		react(),
		cloudflare({
			remoteBindings: useRemoteBindings,
		}),
	],
});
