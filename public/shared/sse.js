// Server-Sent Events, both ways round.
//
// The poster reader streams twice over: Claude streams its answer to the
// Worker as SSE, and the Worker streams the fields it has read to the editor
// as SSE. One parser for both, because the two halves are the same framing and
// a second copy would be a second set of chunk-boundary bugs.
//
// Not EventSource: that cannot POST, and the editor's request carries the
// image. So the browser reads a fetch body and feeds it through this.
//
// The framing (WHATWG HTML, "server-sent events"): lines end in LF, CRLF or a
// lone CR; `field: value` lines accumulate; a line starting with ':' is a
// comment (a keep-alive); a blank line dispatches what has accumulated. Bytes
// arrive in arbitrary chunks, so a line — even a CRLF pair — can be split
// across two pushes, and nothing is dispatched until its blank line arrives.
//
// Classic script, dual shape: the Worker and the tests import it, the editor
// finds it on `window.AgoraSSE`.
(function (root) {
  /**
   * @param {(e: {event: string, data: string, id?: string}) => void} onEvent
   * @returns {{push(text: string): void, end(): void}}
   */
  function createSseParser(onEvent) {
    let buf = '';
    let event = '', data = [], id;

    function dispatch() {
      if (data.length) onEvent({ event: event || 'message', data: data.join('\n'), id });
      event = ''; data = []; id = undefined;
    }

    function line(l) {
      if (l === '') return dispatch();
      if (l[0] === ':') return;                   // comment / keep-alive
      const i = l.indexOf(':');
      const field = i < 0 ? l : l.slice(0, i);
      let value = i < 0 ? '' : l.slice(i + 1);
      if (value[0] === ' ') value = value.slice(1);
      if (field === 'event') event = value;
      else if (field === 'data') data.push(value);
      else if (field === 'id') id = value;
      // `retry` and unknown fields are ignored, as the spec says.
    }

    return {
      push(text) {
        buf += text;
        let start = 0;
        for (let i = 0; i < buf.length; i++) {
          const ch = buf[i];
          if (ch !== '\n' && ch !== '\r') continue;
          // A CR at the very end may be the first half of a CRLF still in
          // flight; leave it for the next push to settle.
          if (ch === '\r' && i === buf.length - 1) break;
          line(buf.slice(start, i));
          if (ch === '\r' && buf[i + 1] === '\n') i++;
          start = i + 1;
        }
        buf = buf.slice(start);
      },
      /** The stream closed. A final event with no blank line after it still counts. */
      end() {
        if (buf) { line(buf.replace(/\r$/, '')); buf = ''; }
        dispatch();
      },
    };
  }

  /** One frame, ready to write. JSON never contains a raw newline, so one data line. */
  function sseFrame(event, payload) {
    return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  }

  const api = { createSseParser, sseFrame };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else if (root) root.AgoraSSE = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
