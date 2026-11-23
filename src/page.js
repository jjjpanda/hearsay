import { applyPageOptions } from './options.js';

const element = document.querySelector('market-ecosystem');
applyPageOptions(element);
await import('./main.js');
const sync = () => {
  const { theme, transparent } = element.options;
  document.documentElement.style.colorScheme = theme;
  document.body.style.background = transparent ? 'transparent' : theme === 'light' ? '#e3dfd5' : '#0f1214';
};
new MutationObserver(sync).observe(element, { attributes: true, attributeFilter: ['theme', 'transparent'] });
sync();
