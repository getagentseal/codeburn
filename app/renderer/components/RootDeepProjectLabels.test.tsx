import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { Sankey } from './Sankey'

describe('root distinguishing canonical project labels', () => {
  it('does not discard the parent segment that distinguishes deep cwd siblings', () => {
    const flow = {period:{label:'Today',start:'2026-09-07',end:'2026-09-07'}, models:[{id:'m',label:'m',cost:5}], projects:[{id:'/left/a/x/vault',label:'left/a/x/vault',cost:2},{id:'/right/a/x/vault',label:'right/a/x/vault',cost:3}], links:[{model:'m',project:'/left/a/x/vault',cost:2},{model:'m',project:'/right/a/x/vault',cost:3}]}
    const html=renderToStaticMarkup(<Sankey flow={flow}/>);
    console.log('ROOT_VISIBLE_AX', [...html.matchAll(/aria-label="([^"]+)"/g)].map(m=>m[1]));
    expect(html).toContain('left/a/x/vault ·');
    expect(html).toContain('right/a/x/vault ·');
  });
});
