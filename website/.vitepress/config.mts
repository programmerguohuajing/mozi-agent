import { defineConfig } from 'vitepress';

export default defineConfig({
  lang: 'zh-CN',
  title: '墨子 Mozi',
  description: '常驻本机的开源编码智能体 —— 引擎即产品',
  themeConfig: {
    nav: [
      { text: '指南', link: '/guide/getting-started' },
      { text: 'API 参考', link: '/guide/api/engine' },
      { text: '评测', link: '/benchmark' },
      { text: 'GitHub', link: 'https://github.com/programmerguohuajing/mozi-agent' },
    ],
    sidebar: {
      '/guide/': [
        {
          text: '开始',
          items: [
            { text: '快速开始', link: '/guide/getting-started' },
            { text: '配置手册', link: '/guide/configuration' },
          ],
        },
        {
          text: '扩展',
          items: [
            { text: '工具扩展开发', link: '/guide/extending-tools' },
            { text: '引擎嵌入指南', link: '/guide/embedding' },
          ],
        },
        {
          text: '深入',
          items: [{ text: '安全模型白皮书', link: '/guide/security' }],
        },
        {
          text: 'API 参考',
          items: [
            { text: 'Engine（@mozi/core）', link: '/guide/api/engine' },
            { text: 'Tools（@mozi/tools）', link: '/guide/api/tools' },
            { text: 'Providers（@mozi/providers）', link: '/guide/api/providers' },
            { text: 'Events & DTO（@mozi/shared）', link: '/guide/api/events' },
          ],
        },
      ],
    },
    socialLinks: [{ icon: 'github', link: 'https://github.com/programmerguohuajing/mozi-agent' }],
    outline: { level: [2, 3] },
    search: { provider: 'local' },
  },
});
