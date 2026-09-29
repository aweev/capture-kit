import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';

import { resolveSecret } from './auth.ts';

/**
 * Publish adapters (FR-34): local folder, S3/R2, GitHub Pages, Netlify/Vercel
 * drop. `folder` and `github-pages` copy files directly. `s3`/`r2` shell out
 * to the AWS CLI (`s3 sync`, R2 via `--endpoint-url`) so no SDK dependency
 * ships with the tool; without the CLI they fail with installation
 * instructions. `netlify`/`vercel` stage a ready-to-deploy folder and print
 * the exact deploy command instead of shipping tokens to a third party.
 */

const execFileAsync = promisify(execFile);

export const publishTargetSchema = z.union([
  z.object({ type: z.literal('folder'), dest: z.string().min(1) }).strict(),
  z
    .object({ type: z.literal('github-pages'), dest: z.string().min(1), cname: z.string().optional() })
    .strict(),
  z
    .object({ type: z.literal('s3'), bucket: z.string().min(1), prefix: z.string().default(''), region: z.string().optional() })
    .strict(),
  z
    .object({
      type: z.literal('r2'),
      bucket: z.string().min(1),
      endpoint: z.string().url(),
      prefix: z.string().default(''),
      accessKey: z.string().min(1).optional(),
      secretKey: z.string().min(1).optional(),
    })
    .strict(),
  z.object({ type: z.literal('netlify'), dest: z.string().min(1) }).strict(),
  z.object({ type: z.literal('vercel'), dest: z.string().min(1) }).strict(),
]);

export type PublishTarget = z.infer<typeof publishTargetSchema>;

export const publishSchema = z.array(publishTargetSchema).max(6).default([]);

export type PublishResult = { type: string; detail: string };

async function copyRun(runDir: string, dest: string): Promise<void> {
  await mkdir(path.dirname(path.resolve(dest)), { recursive: true });
  await cp(runDir, dest, { recursive: true });
}

async function awsSync(localDir: string, remote: string, options: { region?: string; endpoint?: string; env?: Record<string, string> }): Promise<void> {
  const args = ['s3', 'sync', localDir, remote, '--delete'];
  if (options.endpoint) args.push('--endpoint-url', options.endpoint);
  if (options.region) args.push('--region', options.region);
  try {
    await execFileAsync('aws', args, { env: { ...process.env, ...options.env } });
  } catch (err) {
    const msg = (err as Error).message;
    if (/not recognized|ENOENT|not found/i.test(msg)) {
      throw new Error('AWS CLI not found. Install it: https://aws.amazon.com/cli/ (`aws --version` to verify).');
    }
    throw new Error(`aws s3 sync failed: ${msg.slice(0, 400)}`);
  }
}

/** Publish one run directory to one target. Returns a human-readable receipt. */
export async function publishRun(
  runDir: string,
  target: PublishTarget,
  options: { cwd?: string } = {},
): Promise<PublishResult> {
  const cwd = options.cwd ?? process.cwd();
  const resolve = (value: string) => resolveSecret(value);
  switch (target.type) {
    case 'folder': {
      const dest = path.resolve(cwd, target.dest);
      await copyRun(runDir, dest);
      return { type: 'folder', detail: dest };
    }
    case 'github-pages': {
      const dest = path.resolve(cwd, target.dest);
      await copyRun(runDir, dest);
      await writeFile(path.join(dest, '.nojekyll'), '', 'utf8');
      if (target.cname) await writeFile(path.join(dest, 'CNAME'), `${target.cname}\n`, 'utf8');
      return { type: 'github-pages', detail: `${dest} (commit and push to deploy)` };
    }
    case 's3': {
      const remote = `s3://${target.bucket}/${target.prefix}`.replace(/\/+$/, '');
      await awsSync(runDir, remote, target.region ? { region: target.region } : {});
      return { type: 's3', detail: remote };
    }
    case 'r2': {
      const remote = `s3://${target.bucket}/${target.prefix}`.replace(/\/+$/, '');
      const env: Record<string, string> = {};
      if (target.accessKey) env.AWS_ACCESS_KEY_ID = resolve(target.accessKey);
      if (target.secretKey) env.AWS_SECRET_ACCESS_KEY = resolve(target.secretKey);
      await awsSync(runDir, remote, { endpoint: target.endpoint, env });
      return { type: 'r2', detail: `${remote} via ${target.endpoint}` };
    }
    case 'netlify':
    case 'vercel': {
      const dest = path.resolve(cwd, target.dest);
      await copyRun(runDir, dest);
      const cmd = target.type === 'netlify' ? `netlify deploy --dir ${dest} --prod` : `vercel --prod ${dest}`;
      await writeFile(path.join(dest, 'DEPLOY.txt'), `Deploy with:\n  ${cmd}\n`, 'utf8');
      try {
        await readFile(path.join(dest, 'preview.html'), 'utf8');
      } catch {
        await writeFile(
          path.join(dest, 'index.html'),
          '<!doctype html><html><body><p>Run staged for deploys. Open preview.html for the gallery.</p></body></html>\n',
          'utf8',
        );
      }
      return { type: target.type, detail: `staged at ${dest}; deploy with: ${cmd}` };
    }
  }
}
