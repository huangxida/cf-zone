import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const workerDistDir = join(process.cwd(), 'dist', 'cf_zone');

if (!existsSync(workerDistDir)) {
	process.exit(0);
}

for (const entry of readdirSync(workerDistDir, { withFileTypes: true })) {
	if (entry.isDirectory()) {
		continue;
	}

	if (entry.name === '.dev.vars' || entry.name.startsWith('.env')) {
		rmSync(join(workerDistDir, entry.name), { force: true });
	}
}
