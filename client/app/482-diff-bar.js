/* ------------------------------------------------------------------ *
 *  Diff（続き）— ツールバー
 * ------------------------------------------------------------------ */

Object.assign(Diff, {

  /* -------------------------------------------------- *
   *  バー
   * -------------------------------------------------- */

  /** 上段（材料）と下段（操作）を組み立てる。表示中の比較タブのぶんだけ描く。 */
  renderBar(tab) {
    const leaf = Panes.leafOf(tab.id);
    if (!leaf || leaf.activeId !== tab.id) return;
    const d = tab.diff;
    const bar = leaf.el.diffBar;
    bar.textContent = '';

    bar.appendChild(h('div', { class: 'diffbar__row' }, [
      Diff.sourceChip(tab, 'a'),
      h('button', {
        type: 'button', class: 'btn btn--icon', title: '左右を入れ替え',
        onclick: () => { void Diff.swap(tab); }
      }, [icon('swap')]),
      Diff.sourceChip(tab, 'b')
    ]));

    const tools = h('div', { class: 'diffbar__row diffbar__row--tools' }, [
      Diff.statsNode(tab),
      h('span', { class: 'diffbar__spacer' })
    ]);

    tools.appendChild(Diff.toolBtn('', {
      icon: 'arrow-up', title: '前の差分へ（Shift+F7）',
      disabled: !d.stats.count, onClick: () => Diff.nav(tab, -1)
    }));
    tools.appendChild(Diff.toolBtn('', {
      icon: 'arrow-down', title: '次の差分へ（F7）',
      disabled: !d.stats.count, onClick: () => Diff.nav(tab, 1)
    }));
    tools.appendChild(h('span', { class: 'mdbar__sep' }));

    tools.appendChild(Diff.toolBtn('並列', {
      icon: 'columns', on: d.mode === 'split',
      title: '左右に並べて比べる', onClick: () => { void Diff.setMode(tab, 'split'); }
    }));
    tools.appendChild(Diff.toolBtn('インライン', {
      icon: 'rows', on: d.mode === 'unified',
      title: '1 つの画面に元の行を重ねて比べる', onClick: () => { void Diff.setMode(tab, 'unified'); }
    }));
    tools.appendChild(h('span', { class: 'mdbar__sep' }));

    if (d.mode === 'split' && !d.normalize) {
      tools.appendChild(Diff.toolBtn(d.revert === 'a-to-b' ? '左 → 右' : '左 ← 右', {
        title: 'ブロック単位でコピーする向き（矢印を押すとコピーされます）',
        onClick: () => Diff.flipRevert(tab)
      }));
    }
    tools.appendChild(Diff.toolBtn('同じ行を畳む', {
      on: d.collapse, title: '変更の周り 3 行だけ残して畳む',
      onClick: () => Diff.toggleCollapse(tab)
    }));
    tools.appendChild(Diff.toolBtn('空白を無視', {
      on: d.normalize,
      title: '行の前後と行内の空白・空行の違いを無視して比べる（表示も整形後になるため、この間は書き戻せません）',
      onClick: () => { void Diff.toggleNormalize(tab); }
    }));

    const writeA = Diff.writeBackLabel(tab, 'a');
    const writeB = Diff.writeBackLabel(tab, 'b');
    if (writeA || writeB) tools.appendChild(h('span', { class: 'mdbar__sep' }));
    if (writeA) {
      tools.appendChild(Diff.toolBtn(writeA.label, {
        icon: 'save', title: writeA.title, onClick: () => { void Diff.writeBack(tab, 'a'); }
      }));
    }
    if (writeB) {
      tools.appendChild(Diff.toolBtn(writeB.label, {
        icon: 'save', title: writeB.title, onClick: () => { void Diff.writeBack(tab, 'b'); }
      }));
    }

    bar.appendChild(tools);
  },

  /** 左右の材料。押すと材料を選ぶメニューが出る。 */
  sourceChip(tab, which) {
    const side = tab.diff[which];
    return h('button', {
      type: 'button',
      class: 'diffsrc diffsrc--' + which,
      title: (which === 'a' ? '左' : '右') + ': ' + side.name + '\n' + side.sub +
        '\nクリックで材料を選び直せます',
      onclick: (ev) => Diff.sourceMenu(tab, which, ev.currentTarget)
    }, [
      h('span', { class: 'diffsrc__side', text: which === 'a' ? '左' : '右' }),
      h('span', { class: 'diffsrc__name', text: Diff.sideLabel(side) }),
      side.dirty ? h('span', { class: 'diffsrc__dirty', title: '書き戻していない変更' }, [icon('dot')]) : null,
      h('span', { class: 'diffsrc__sub', text: side.sub }),
      h('span', { class: 'diffsrc__chev' }, [icon('chevron')])
    ]);
  },

  statsNode(tab) {
    const d = tab.diff;
    const s = d.stats;
    if (!d.view) return h('span', { class: 'diffstat', text: '準備中…' });
    if (d.a.origin === 'empty' && d.b.origin === 'empty') {
      return h('span', { class: 'diffstat', text: '左右の材料を選んでください' });
    }
    if (!s.count) {
      return h('span', { class: 'diffstat' }, [
        h('span', { class: 'diffstat__same' }, [
          icon('equal'), h('span', { text: '差分なし（同じ内容）' })
        ]),
        d.normalize ? h('span', { class: 'diffstat__warn', text: '· 整形して比較' }) : null
      ]);
    }
    return h('span', { class: 'diffstat' }, [
      h('span', { text: s.count + ' 箇所' }),
      h('span', { class: 'diffstat__del', text: '−' + s.del + ' 行' }),
      h('span', { class: 'diffstat__ins', text: '+' + s.ins + ' 行' }),
      s.precise === false
        ? h('span', { class: 'diffstat__warn', text: '· 大きいので簡易比較' })
        : null,
      d.normalize
        ? h('span', { class: 'diffstat__warn', text: '· 整形して比較（閲覧のみ）' })
        : null
    ]);
  },

  /** 下段のボタン。見た目は Markdown の入力バーと同じものを使う。 */
  toolBtn(label, opts) {
    const o = opts || {};
    return h('button', {
      type: 'button',
      class: 'mdbar__btn' + (o.on ? ' mdbar__btn--on' : '') + (o.icon ? ' mdbar__btn--icon' : ''),
      title: o.title || label,
      disabled: !!o.disabled,
      onclick: o.onClick
    }, [
      o.icon ? icon(o.icon) : null,
      label ? h('span', { text: label }) : null
    ]);
  },

  /** 書き戻しボタンの文言。書き戻す先が無い、または変更が無ければ出さない。 */
  writeBackLabel(tab, which) {
    const d = tab.diff;
    const side = d[which];
    if (d.normalize || !side.dirty) return null;
    const label = which === 'a' ? '左' : '右';
    if (side.target === 'drive') {
      return { label: label + 'を保存', title: '「' + side.name + '」を Drive に保存します' };
    }
    if (side.target === 'tab') {
      return { label: label + 'をタブへ', title: '「' + side.name + '」のタブに反映します（保存は通常どおり走ります）' };
    }
    return { label: label + 'を書き出す…', title: '新しいファイルとして保存します' };
  }
});
