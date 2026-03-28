import react from '@vitejs/plugin-react';
import { cloudflare } from '@cloudflare/vite-plugin';
import { defineConfig } from 'vite';

const useRemoteBindings = process.env.CF_REMOTE_BINDINGS === '1';

export default defineConfig({
	plugins: [
		react(),
		cloudflare({
			remoteBindings: useRemoteBindings,
		}),
	],
});
