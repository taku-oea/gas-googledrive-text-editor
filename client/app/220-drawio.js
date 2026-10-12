/* ------------------------------------------------------------------ *
 *  drawio のプレビュー（読み取り専用）
 *
 *  embed.diagrams.net を iframe に出し、XML を postMessage で渡して描かせる。
 *  URL に図を載せる方式（#R...）もあるが、更新のたびに iframe を読み込み直す
 *  ことになるので、やり取りできるこちらにしている。
 *
 *  図の中身はブラウザの中で diagrams.net のページに渡る（描画はクライアント側で
 *  完結し、向こうのサーバーへは送られない）。それでも第三者のページに図の中身を
 *  読ませることにはなるので、docs/limitations.md にも明記してある。
 *
 *  読み取り専用にしているので、ここから Drive へ書き戻すことはない。
 *  編集したいときはエディタ側の XML を直すか、drawio 本体で開く。
 *
 *  状態はプレビュータブごとに持つ（tab.pv.drawio）。図のタブを 2 枚開けば
 *  iframe も 2 つになり、どちらから来たメッセージかは contentWindow で見分ける。
 * ------------------------------------------------------------------ */

function drawioSrc() {
  return DRAWIO_ORIGIN + '/?embed=1&proto=json&chrome=0&spin=1'
    + '&dark=' + (Theme.resolved === 'dark' ? '1' : '0')
    + '&noSaveBtn=1&noExitBtn=1&saveAndExit=0&libraries=0';
}

const Drawio = {
  /** iframe を読み込む。すでに読んでいれば何もしない。 */
  open(tab) {
    const pv = tab.pv;
    const d = pv.drawio;
    if (d.loaded) return;
    d.loaded = true;
    d.ready = false;
    pv.fallback.hidden = true;
    pv.dio.src = drawioSrc();

    // 組織のネットワークから diagrams.net に届かないことがある。
    // 白いままだと理由が分からないので、待って案内へ切り替える。
    clearTimeout(d.timer);
    d.timer = setTimeout(() => {
      if (d.ready || !tab.pv) return;
      pv.dio.hidden = true;
      pv.fallback.hidden = false;
      pv.fallback.textContent =
        'diagrams.net を読み込めませんでした。ネットワークから embed.diagrams.net に'
        + '到達できるか確認してください。ファイルの中身（XML）はエディタ側で編集できます。';
    }, 15000);
  },

  /** 閉じるときに止める。裏で動かし続けない。 */
  close(tab) {
    const pv = tab && tab.pv;
    if (!pv) return;
    const d = pv.drawio;
    clearTimeout(d.timer);
    d.ready = false;
    d.pending = null;
    if (!d.loaded) return;
    d.loaded = false;
    // about:blank へ飛ばして diagrams.net のページを止める。
    pv.dio.src = 'about:blank';
  },

  /** テーマが変わったとき。配色は URL に載せているので読み込み直す。 */
  reload(tab) {
    const pv = tab && tab.pv;
    if (!pv || !pv.drawio.loaded) return;
    const xml = pv.drawio.pending;
    Drawio.close(tab);
    Drawio.open(tab);
    if (xml !== null) Drawio.show(tab, xml);
  },

  /** 図を描き直す。init 前なら覚えておく。 */
  show(tab, xml) {
    const pv = tab.pv;
    pv.drawio.pending = xml;
    if (pv.drawio.ready) Drawio.load(tab, xml);
  },

  load(tab, xml) {
    const win = tab.pv.dio.contentWindow;
    // embed プロトコルは JSON 文字列でやり取りする（オブジェクトのままだと無視される）。
    // 宛先を固定する。iframe が別のページへ移っていたら、図の中身（XML）は渡さない。
    if (win) win.postMessage(JSON.stringify({ action: 'load', xml: xml, autosave: 0 }), DRAWIO_ORIGIN);
  },

  /** どのプレビュータブの iframe から来たメッセージか。 */
  tabForSource(source) {
    if (!source) return null;
    return App.tabs.find((t) =>
      t.kind === 'preview' && t.pv && t.pv.dio.contentWindow === source) || null;
  },

  /** iframe からのメッセージ。init が来た時点で描ける。 */
  onMessage(tab, data) {
    const pv = tab.pv;
    if (!pv) return;
    let msg = null;
    try {
      msg = JSON.parse(data);
    } catch (err) {
      return;
    }
    if (!msg || msg.event !== 'init') return;

    clearTimeout(pv.drawio.timer);
    pv.drawio.ready = true;
    pv.fallback.hidden = true;
    if (pv.mode === 'drawio') pv.dio.hidden = false;
    if (pv.drawio.pending !== null) Drawio.load(tab, pv.drawio.pending);
  }
};

