// A WebCast control channel is authenticated by the Launcher WebRTC session.
// Discovery capabilities are only an optimisation/UI hint: manual pairing has
// no selected discovery record, but it must still be able to receive Bind and
// Touchback frames from the authenticated receiver.
export function canAttachTouchbackChannel(channel, protocol = 'webcast') {
  return protocol === 'webcast' && channel?.readyState === 'open';
}
