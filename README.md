# @getjolt/sdk

Everything you need to build a Jolt client. The official desktop app is a thin layer of UI on top of this package, so anything it can do, your app can do too: sign in, join servers on any instance, keep a live copy of everything the user can see, and send messages that show up instantly.

It has no UI or framework dependencies. It needs `fetch`, `WebSocket` and Web Crypto, which every modern browser has, along with Node 22 or newer, Deno and Bun.

## Install

```sh
npm install @getjolt/sdk
```

## A first client

`JoltSession` is the piece most apps want. You give it somewhere to keep secrets (a session token and a per-device signing key) and it takes care of the rest.

```ts
import { JoltSession } from '@getjolt/sdk';

const session = new JoltSession({
  storage: {
    get: async (key) => localStorage.getItem(key),
    set: async (key, value) => localStorage.setItem(key, value),
    delete: async (key) => localStorage.removeItem(key),
  },
  deviceName: 'My Jolt client',
});

if (!(await session.restore())) {
  await session.login('joltapp.org', 'alice', 'correct horse battery staple');
}

session.store.subscribe((state) => render(state));

session.on('message', ({ message, mentionsMe }) => {
  if (mentionsMe) notify(`${message.author.displayName}: ${message.content}`);
});
```

`localStorage` keeps the example short, but in a real app put these somewhere encrypted. The desktop app uses Electron's `safeStorage`.

## Showing it on screen

`session.store` is a tiny observable store with `getState`, `subscribe` and `getInitialState`. That's the same shape zustand uses, so in React you can write `useStore(session.store, (s) => s.guilds)`. Without zustand, `useSyncExternalStore(session.store.subscribe, session.store.getState)` does the job. Svelte, Vue and Solid can wrap `subscribe` in a couple of lines.

IDs are only unique within one instance, so guilds and channels in the store are keyed as `instance|id`. `scoped(instance, id)` builds a key and `unscope(key)` takes one apart. The state has your guilds (with their channels, roles, members and presence), the messages for channels you've loaded, read states, who's typing, and the connection status for each instance. Helpers like `isUnread`, `guildActivity`, `sortedTextChannels`, `permissionsFor` and `typingUsers` cover the things every client ends up computing.

## Doing things

```ts
import { scoped, sortedTextChannels } from '@getjolt/sdk';

const guild = Object.values(session.state.guilds)[0];
const general = scoped(guild.instance, sortedTextChannels(guild.channels)[0].id);

await session.loadMessages(general);
await session.loadMessages(general, 'older');
await session.sendMessage(general, 'hello **world**');
session.notifyTyping(general);
session.markRead(general, lastMessageId);

const invite = session.parseInvite('jolt://invite/studio.example/AbC123');
if (invite) await session.joinInvite(invite);
```

Messages appear in the store as soon as you send them and are swapped for the server's copy when it arrives, so there's no flicker and no duplicates. `notifyTyping` and `markRead` throttle themselves, so you can call them as often as you like. `findInviteLinks(text)` spots invite links in a message, which is how the desktop app turns them into cards. To change the user's picture, pass an image `Blob` (a `File` from an input works) to `session.setAvatar`, or `null` to remove it. Crop and shrink it first if you can, since instances cap avatars at 1 MB and 1024 pixels a side.

For anything that isn't wrapped, `session.rest(instance)` gives you a typed REST client for that instance.

## The timeline

`session.social` covers the social side: timelines, profiles, posting, likes, reposts, follows and notifications. Like chat, it keeps a live copy in the store under `state.social`, and new posts from people you follow arrive over the same gateway.

```ts
import { feedKey } from '@getjolt/sdk';

await session.social.loadFeed(feedKey.home);
const image = await session.social.uploadMedia(file);
await session.social.createPost({ text: 'Morning! #jolt', media: [{ ...image, alt: 'Coffee on a desk' }] });

const someone = await session.social.lookup('@lou@mastodon.social');
await session.social.setFollowing(someone.user.id, true);
```

Posts come back as text plus facets (links, mentions and hashtags with their positions), whether they were written on Jolt or arrived from Mastodon, so you never have to render HTML from another server. Your own posts appear straight away and new ones from other people wait in `feed.fresh` until you call `showFresh()`, so the list doesn't jump while someone is reading. All of it talks to the user's home instance, which handles federation for you.

Linked accounts work the same way. `session.social.linkAccount('bluesky', 'name.bsky.social')` returns a page to open in the browser, and once the user approves, the link arrives over the gateway. After that `feedKey.link(id)` loads that account's own timeline, likes and replies on its posts go out as that account, `crosspost: [id]` on `createPost` posts there too, and `findFriends(id)` lists who they follow and how to follow each of them here.

## Federation, without thinking about it

Your account lives on your home instance. When you open a server that lives somewhere else, the SDK asks your home instance for a short-lived certificate for this device, proves to the other instance that it holds the matching key, and gets a session there. It renews certificates before they expire and signs in again if a session lapses. You never deal with any of it, but [PROTOCOL.md](https://github.com/GetJolt/protocol/blob/main/PROTOCOL.md) explains how it works if you're curious.

## Lower levels

If you'd rather manage state yourself, `JoltClient` gives you the connections and federation without the store. `RestClient` and `GatewayClient` talk to a single instance, which is handy for bots. The raw types and schemas come from [`@getjolt/protocol`](https://github.com/GetJolt/protocol).

## Development

```sh
npm install
npm test
npm run build
```

The end to end tests live in the [server repository](https://github.com/GetJolt/server), which spins up real instances and drives them with this SDK.

## License

MIT. See [LICENSE](LICENSE).
