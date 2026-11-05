// A WebCast control channel is authenticated by the Launcher WebRTC session.
// Discovery capabilities are only an optimisation/UI hint: manual pairing has
// no selected discovery record. Typed input still requires its own standard
// session, local opt-in and proven source context after channel attachment.
export function canAttachTouchbackChannel(channel, protocol = 'webcast') {
  return protocol === 'webcast' && channel?.readyState === 'open';
}
