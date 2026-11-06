window.__ModuleLoader__.load({
  id: '@local/whale-intro-icons',
  factory() {
    // An additive theme patch: the original buttons, labels, and handlers stay intact.
    const svgMask = (paths) => `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`)}")`;
    const pin = svgMask('<rect x="2.5" y="7" width="13" height="14" rx="2"/><path d="M6 7v14M2.5 11H6m-3.5 6H6M12 3h8m-6 0v4l-2 3h8l-2-3V3m-2 7v5"/>');
    const library = svgMask('<path d="M7 3h12a2 2 0 0 1 2 2v12"/><rect x="3" y="7" width="14" height="14" rx="2"/><path d="m8.5 11 5 3-5 3z"/>');
    const button = 'html[data-dsh-skin="whale-fantasy"] .dba-pin-wrap > button.dba-pin';
    const css = `
${button} {
  font-size: 0 !important;
  color: #9bbcf5;
  transition: color 140ms ease, background-color 140ms ease, box-shadow 140ms ease;
}
${button}::before {
  content: "";
  display: block;
  flex: 0 0 18px;
  width: 18px;
  height: 18px;
  pointer-events: none;
  background-color: currentColor;
  -webkit-mask-image: ${pin};
  mask-image: ${pin};
  -webkit-mask-size: contain;
  mask-size: contain;
  -webkit-mask-repeat: no-repeat;
  mask-repeat: no-repeat;
  -webkit-mask-position: center;
  mask-position: center;
}
${button}.dba-lib-open::before {
  -webkit-mask-image: ${library};
  mask-image: ${library};
}
${button}:hover:not(:disabled),
${button}:focus-visible {
  color: #39ffd1;
  background-color: rgba(57, 255, 209, 0.10);
}
${button}:focus-visible {
  outline: 1px solid #39ffd1;
  outline-offset: 2px;
}
${button}.dba-pin-on {
  color: #39ffd1;
  background-color: rgba(57, 255, 209, 0.12);
  box-shadow: inset 0 0 0 1px rgba(57, 255, 209, 0.32);
}
@media (prefers-reduced-motion: reduce) {
  ${button} { transition: none; }
}
`;
    return {
      apply(ctx) {
        ctx.effect(() => {
          const style = document.createElement('style');
          style.id = 'whale-intro-icons-style';
          style.textContent = css;
          document.head.appendChild(style);
          return () => style.remove();
        });
      },
    };
  },
});
