// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// https://astro.build/config
export default defineConfig({
  site: 'https://docs.cortadel.com',
  integrations: [
    starlight({
      title: 'Cortadel',
      description:
        'Self-hosted long-term temporal graph memory for AI agents — MCP, REST and a dashboard in one container.',
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/cortadel/cortadel' },
      ],
      editLink: { baseUrl: 'https://github.com/cortadel/cortadel/edit/main/website/' },
      sidebar: [
        {
          label: 'Start here',
          items: [
            { label: 'Getting started', slug: 'getting-started' },
            { label: 'Self-hosting the server', slug: 'self-hosting' },
            { label: 'Authentication', slug: 'authentication' },
          ],
        },
        {
          label: 'Integrate',
          items: [
            { label: 'MCP integration', slug: 'mcp' },
            { label: '.NET SDK reference', slug: 'sdk-dotnet' },
            { label: 'Python SDK reference', slug: 'sdk-python' },
            { label: 'TypeScript SDK reference', slug: 'sdk-typescript' },
          ],
        },
      ],
    }),
  ],
});
