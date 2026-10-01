import { describe, expect, it } from 'vitest';
import { findInviteLinks, parseInvite } from '../src/session.js';

describe('invite links', () => {
  it('finds deep links and web links in running text', () => {
    const found = findInviteLinks(
      'join us jolt://invite/joltapp.org/AbC123 or https://b.example:4200/invite/XyZ789!',
    );
    expect(found).toEqual([
      { instance: 'joltapp.org', code: 'AbC123', match: 'jolt://invite/joltapp.org/AbC123' },
      { instance: 'b.example:4200', code: 'XyZ789', match: 'https://b.example:4200/invite/XyZ789' },
    ]);
  });

  it('ignores links inside code and duplicates', () => {
    const text =
      'jolt://invite/a.example/Code1234 `jolt://invite/a.example/Hidden12` jolt://invite/a.example/Code1234';
    expect(findInviteLinks(text).map((i) => i.code)).toEqual(['Code1234']);
    expect(findInviteLinks('```\njolt://invite/a.example/Hidden12\n```')).toEqual([]);
  });

  it('parses pasted invites in every supported shape', () => {
    expect(parseInvite('jolt://invite/a.example/AbC123', 'home')).toEqual({
      instance: 'a.example',
      code: 'AbC123',
    });
    expect(parseInvite('a.example/invite/AbC123', 'home')).toEqual({ instance: 'a.example', code: 'AbC123' });
    expect(parseInvite('AbC123', 'home')).toEqual({ instance: 'home', code: 'AbC123' });
    expect(parseInvite('not an invite', 'home')).toBeNull();
  });
});
