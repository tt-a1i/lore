/** 占位：由实现 agent 填充。导出协议：CSS 字符串 + JS 字符串（JS 内 LORE_VIEWS.push 注册）。 */
export const CSS = '';
export const JS = `
window.LORE_VIEWS.push({
  id: 'decisions', label: 'decisions',
  mount(el, ctx) { el.innerHTML = '<div style="display:flex;height:100%;align-items:center;justify-content:center;color:var(--text-faint)">decisions view — coming up</div>'; },
  onTimeline() {},
});
`;
