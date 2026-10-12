/* ------------------------------------------------------------------ *
 *  トースト・モーダル
 * ------------------------------------------------------------------ */

function toast(message, kind = 'info', ms = 6000) {
  const node = h('div', { class: 'toast toast--' + kind, text: message });
  el.toasts.appendChild(node);
  setTimeout(() => {
    node.style.transition = 'opacity .2s';
    node.style.opacity = '0';
    setTimeout(() => node.remove(), 220);
  }, ms);
}

/** いま出ているモーダル（閉じたら解決する）。モーダルの DOM は 1 組しかないので順番に出す。 */
let modalQueue = Promise.resolve();

/**
 * ボタン付きモーダルを出し、押されたボタンの value を返す。
 * 別のモーダルが出ている間に呼ばれたら、それが閉じてから出す。上書きして出すと、
 * 先のモーダルの Promise が解決されないまま残り、Esc では見えていない方にも null が返る
 * （例: 裏の保存の競合で下書きの復元確認が隠れ、Esc で下書きが破棄される）。
 * @param {{title:string, body:(string|Node), actions:Array, wide?:boolean,
 *          onOpen?:function(): void}} opts
 * @return {Promise<*>}
 */
function modal(opts) {
  const shown = modalQueue.then(() => showModal(opts));
  modalQueue = shown.then(() => {}, () => {});
  return shown;
}

function showModal(opts) {
  return new Promise((resolve) => {
    el.modal.classList.toggle('modal--wide', !!opts.wide);
    el.modalTitle.textContent = opts.title;
    el.modalBody.textContent = '';
    el.modalBody.appendChild(typeof opts.body === 'string'
      ? document.createTextNode(opts.body)
      : opts.body);

    el.modalActions.textContent = '';
    for (const action of opts.actions) {
      el.modalActions.appendChild(h('button', {
        type: 'button',
        class: 'btn ' + (action.variant ? 'btn--' + action.variant : ''),
        text: action.label,
        onclick: () => { close(action.value); }
      }));
    }

    const onKey = (ev) => {
      if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); close(null); }
    };
    function close(value) {
      document.removeEventListener('keydown', onKey, true);
      el.modalOverlay.hidden = true;
      resolve(value);
    }

    document.addEventListener('keydown', onKey, true);
    el.modalOverlay.hidden = false;

    if (opts.onOpen) opts.onOpen({ close });
    else {
      const first = el.modalActions.querySelector('.btn--primary') || el.modalActions.querySelector('.btn');
      if (first) first.focus();
    }
  });
}

