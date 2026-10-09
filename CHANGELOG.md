# Changelog

## Unreleased

Adds messages from the home instance itself, like a welcome for new accounts: `social.state.system` holds them with an unread count, `loadSystemMessages` and `markSystemMessagesRead` fetch and clear them, and new ones arrive live. Needs the matching `@getjolt/protocol`.

## 0.2.0

Adds `session.social`: timelines with a "new posts" buffer, posting with images and alt text, replies, quotes, likes, reposts, follows, profiles, threads and notifications, all kept live over the gateway. Linked Bluesky and Mastodon accounts can be added, read and posted to, and `findFriends` lists who someone follows there. Needs `@getjolt/protocol` 0.2.

## 0.1.0

The first public release, with `JoltSession` and its live store, federated sign-in across instances, optimistic messages, read markers, typing, invites, invite link detection and avatar uploads.
