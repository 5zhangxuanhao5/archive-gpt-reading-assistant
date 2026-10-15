import {EditorState, Transaction, StateField, StateEffect} from '@codemirror/state';
import {EditorView, Decoration, WidgetType, keymap, highlightActiveLine, drawSelection, dropCursor, placeholder} from '@codemirror/view';
import {defaultKeymap, history, historyKeymap, indentWithTab} from '@codemirror/commands';
import {markdown, markdownLanguage} from '@codemirror/lang-markdown';
import {languages} from '@codemirror/language-data';
import {syntaxHighlighting, HighlightStyle, bracketMatching, indentOnInput} from '@codemirror/language';
import {tags} from '@lezer/highlight';
import MarkdownIt from 'markdown-it';
import taskLists from 'markdown-it-task-lists';
import footnote from 'markdown-it-footnote';
import texmath from 'markdown-it-texmath';
import katex from 'katex';
import DOMPurify from 'dompurify';

DOMPurify.addHook('afterSanitizeAttributes', node => { if (node.tagName === 'INPUT') { if (node.getAttribute('type') !== 'checkbox') node.remove(); else node.setAttribute('disabled', ''); } if (node.tagName === 'A') node.setAttribute('rel', 'noopener noreferrer'); });
const parser = new MarkdownIt({html: true, linkify: true, breaks: false}).use(taskLists).use(footnote).use(texmath, {engine: katex, delimiters: ['dollars', 'brackets'], katexOptions: {throwOnError: false, strict: 'ignore'}});
const color = HighlightStyle.define([
  {tag: tags.heading, fontWeight: '650', color: 'var(--ink)'},
  {tag: tags.strong, fontWeight: '700'}, {tag: tags.emphasis, fontStyle: 'italic'}, {tag: tags.strikethrough, textDecoration: 'line-through'},
  {tag: tags.link, color: '#3c77b6', textDecoration: 'underline'}, {tag: tags.url, color: 'var(--muted)'},
  {tag: tags.quote, color: 'var(--muted)'}, {tag: tags.monospace, color: 'var(--code)'},
  {tag: tags.processingInstruction, color: 'var(--muted)'}, {tag: tags.meta, color: 'var(--muted)'},
  {tag: tags.keyword, color: 'var(--syntax)'}, {tag: tags.string, color: 'var(--string)'}, {tag: tags.number, color: 'var(--code)'},
  {tag: tags.comment, color: 'var(--muted)'}, {tag: tags.punctuation, color: 'var(--muted)'}
]);
export function renderMarkdown(text) {
  return DOMPurify.sanitize(parser.render(text || ''), {ADD_TAGS: ['eq', 'eqn'], ADD_ATTR: ['class', 'style', 'aria-hidden'], FORBID_TAGS: ['iframe', 'form', 'object', 'embed', 'script'], ALLOW_DATA_ATTR: false});
}
// Preserve unchanged stretches so a remote edit outside the caret does not move it.
function textChanges(before,after) {
  let prefix=0,suffix=0;
  while(prefix<Math.min(before.length,after.length) && before[prefix]===after[prefix])prefix++;
  while(suffix<Math.min(before.length,after.length)-prefix && before[before.length-1-suffix]===after[after.length-1-suffix])suffix++;
  const left=before.slice(prefix,before.length-suffix),right=after.slice(prefix,after.length-suffix);
  if(!left.length || !right.length)return [{from:prefix,to:before.length-suffix,insert:right}];
  const trace=[];let frontier=new Map([[1,0]]),distance=0,found=false,work=0;
  for(distance=0;distance<=Math.min(left.length+right.length,1500);distance++){
    trace.push(new Map(frontier));
    for(let offset=-distance;offset<=distance;offset+=2){
      if(++work>2000000)break;
      let x=offset===-distance || (offset!==distance && (frontier.get(offset-1) ?? -1)<(frontier.get(offset+1) ?? -1))?frontier.get(offset+1) ?? 0:(frontier.get(offset-1) ?? 0)+1,y=x-offset;
      while(x<left.length && y<right.length && left[x]===right[y]){x++;y++;}
      frontier.set(offset,x);if(x>=left.length && y>=right.length){found=true;break;}
    }
    if(found || work>2000000)break;
  }
  if(!found)return [{from:prefix,to:before.length-suffix,insert:right}];
  let x=left.length,y=right.length;const steps=[];
  for(let index=distance;index>=0;index--){
    const frontier=trace[index],offset=x-y;
    const previousOffset=offset===-index || (offset!==index && (frontier.get(offset-1) ?? -1)<(frontier.get(offset+1) ?? -1))?offset+1:offset-1;
    const previousX=frontier.get(previousOffset) ?? 0,previousY=previousX-previousOffset;
    while(x>previousX && y>previousY){steps.push(['=',left[--x]]);y--;}
    if(index>0){if(x===previousX)steps.push(['+',right[--y]]);else steps.push(['-',left[--x]]);}
  }
  steps.reverse();let position=prefix,current;const changes=[];
  for(const [kind,character] of steps){
    if(kind==='='){current=null;position++;}
    else {if(!current){current={from:position,to:position,insert:''};changes.push(current);}if(kind==='-'){position++;current.to++;}else current.insert+=character;}
  }
  return changes;
}
function finishComposition(before,local,remote){
  if(local===before)return remote;if(local===remote || remote===before)return local;
  const own=textChanges(before,local),changes=[...own];
  for(const change of textChanges(before,remote)){
    const duplicate=own.some(item=>item.from===change.from && item.to===change.to && item.insert===change.insert);
    const overlap=own.some(item=>{
      const point=change.from===change.to,otherPoint=item.from===item.to;
      return point && otherPoint?false:point?change.from>item.from && change.from<item.to:otherPoint?item.from>change.from && item.from<change.to:Math.max(change.from,item.from)<Math.min(change.to,item.to);
    });
    if(!duplicate && !overlap)changes.push(change);
  }
  changes.sort((a,b)=>a.from-b.from || a.to-b.to);let result='',position=0;
  for(const change of changes){result+=before.slice(position,change.from)+change.insert;position=Math.max(position,change.to);}
  return result+before.slice(position);
}
export function createEditor(parent, onChange, plainPaste, options = {}) {
  let suppress = false, pendingText = null;
  const setText = value => {
    const text=String(value ?? ''),before=view.state.doc.toString();if(before===text){if(!view.composing)pendingText=null;return;}
    if(view.composing){pendingText={before:pendingText?.before ?? before,text};return;}
    pendingText=null;const changes=view.state.changes(textChanges(before,text));suppress=true;
    try {view.dispatch({changes,selection:view.state.selection.map(changes,-1),annotations:Transaction.addToHistory.of(false)});}
    finally {suppress=false;}
  };
  const redrawQuotes = StateEffect.define();
  class QuoteWidget extends WidgetType {
    constructor(id) { super(); this.id = id; }
    eq(other) { return this.id === other.id; }
    toDOM() { const card = options.quoteWidget(this.id); card.setAttribute('contenteditable', 'false'); return card; }
    ignoreEvent() { return true; }
  }
  const decorate = state => {
    const ranges = [];
    for (const match of state.doc.toString().matchAll(/^<!-- gpt-reader-quote:([\w-]+) -->$/gm)) {
      ranges.push(Decoration.replace({widget: new QuoteWidget(match[1]), block: true}).range(match.index, match.index + match[0].length));
    }
    return Decoration.set(ranges);
  };
  const quoteField = StateField.define({
    create: decorate,
    update: (value, transaction) => transaction.docChanged || transaction.effects.some(effect => effect.is(redrawQuotes)) ? decorate(transaction.state) : value,
    provide: field => EditorView.decorations.from(field)
  });
  const quoteExtensions = options.quoteWidget ? [quoteField, EditorView.atomicRanges.of(view => view.state.field(quoteField))] : [];
  const view = new EditorView({parent, state: EditorState.create({doc: '', extensions: [
    ...quoteExtensions, history(), drawSelection(), dropCursor(), bracketMatching(), indentOnInput(), placeholder(options.placeholder || '输入 Markdown，或粘贴图片…'),
    markdown({base: markdownLanguage, codeLanguages: languages}), syntaxHighlighting(color),
    EditorView.lineWrapping, keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
    EditorView.contentAttributes.of({'aria-label': options.label || 'Markdown 笔记正文', spellcheck: 'false'}),
    EditorView.updateListener.of(update => { if (update.docChanged && !suppress) onChange(update.state.doc.toString()); if (update.selectionSet || update.docChanged) options.onSelection?.(); }),
    EditorView.domEventHandlers({compositionend:()=>{
      const finished=()=>{if(view.composing && view.dom.isConnected){setTimeout(finished,20);return;}options.onCompositionEnd?.();if(pendingText!==null && view.dom.isConnected){const pending=pendingText;pendingText=null;setText(finishComposition(pending.before,view.state.doc.toString(),pending.text));}};
      setTimeout(finished,0);return false;
    },paste: (event, view) => {
      const data = event.clipboardData; if (!data) return false;
      const files = Array.from(data.items || []).filter(item => item.kind === 'file' && item.type.startsWith('image/')).map(item => item.getAsFile()).filter(Boolean);
      if (files.length && options.onImages) { event.preventDefault(); options.onImages(files); return true; }
      event.preventDefault(); const text = plainPaste(data.getData('text/plain'));
      view.dispatch(view.state.replaceSelection(text)); return true;
    }}),
    EditorView.theme({'&': {fontSize: '14px', minHeight: '44px', background: 'transparent', color: 'var(--card-ink,var(--ink))'}, '.cm-content': {fontFamily: "system-ui, -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif", padding: '6px 0', caretColor: 'var(--card-ink,var(--ink))', lineHeight: '1.75'}, '.cm-line': {padding: '0 1px'}, '&.cm-focused': {outline: 'none'}, '.cm-scroller': {overflow: 'visible'}, '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {background: 'var(--selection)'}, '.cm-cursor': {borderLeftColor: 'var(--card-ink,var(--ink))'}, '.cm-activeLine': {background: 'transparent'}, '.cm-gutters': {display: 'none'}})
  ]})});
  return {
    view,
    refreshQuotes: () => { if (options.quoteWidget) view.dispatch({effects: redrawQuotes.of(null)}); },
    getText: () => view.state.doc.toString(),
    focus: () => view.focus(),
    setText,
    format: kind => {
      const {from, to} = view.state.selection.main; const selected = view.state.sliceDoc(from, to);
      const pairs = {bold: ['**', '**'], italic: ['*', '*'], underline: ['<u>', '</u>'], strike: ['~~', '~~'], code: ['`', '`'], link: ['[', '](https://)'], image: ['![', '](https://)'], math: ['$', '$']};
      let start = from, end = to, insert;
      let selection;
      if (pairs[kind]) {
        const [left, right] = pairs[kind];
        if (from >= left.length && view.state.sliceDoc(from - left.length, from) === left && view.state.sliceDoc(to, to + right.length) === right) {
          start -= left.length; end += right.length; insert = selected; selection = {anchor: start, head: start + insert.length};
        } else if (selected.startsWith(left) && selected.endsWith(right) && selected.length >= left.length + right.length) {
          insert = selected.slice(left.length, -right.length); selection = {anchor: start, head: start + insert.length};
        } else { const content = selected || (kind === 'image' ? '图片说明' : '文字'); insert = left + content + right; selection = {anchor: start + left.length, head: start + left.length + content.length}; }
      }
      else if (kind === 'fence') insert = '\n```\n' + (selected || '代码') + '\n```\n';
      else if (kind === 'table') insert = '\n| 列一 | 列二 |\n| --- | --- |\n| 内容 | 内容 |\n';
      else if (kind === 'rule') insert = '\n\n---\n\n';
      else {
        start = view.state.doc.lineAt(from).from; end = view.state.doc.lineAt(to).to;
        const prefix = {heading: '## ', quote: '> ', bullet: '- ', ordered: '1. ', task: '- [ ] '}[kind] || '';
        insert = view.state.sliceDoc(start, end).split('\n').map(line => prefix + line).join('\n');
      }
      view.dispatch({changes: {from: start, to: end, insert}, selection: selection || {anchor: start + insert.length}}); view.focus();
    }
  };
}
