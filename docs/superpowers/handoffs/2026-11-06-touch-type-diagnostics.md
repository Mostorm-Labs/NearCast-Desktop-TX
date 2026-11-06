# Touch type diagnostics

The current RX R2 WebCastInputPeer requests inputTypes:[touch]. Its TouchbackCodec
sets allow_mouse=false and uses typed input contact records. The TX decoder maps
type byte 1 to touch and byte 2 to mouse. Geometry mapping and local contact-ID
allocation preserve inputType:touch. Windows prepare accepts only the touch
contract; submitted Touch calls InjectTouchInput with PT_TOUCH. A Mouse sample
on a Touch-only stream is rejected before the native provider is invoked. No
Touch-to-Mouse conversion is introduced by the queue coalescer or this change.

The user's report of mouse-like application behavior cannot establish a wire type.
Windows can generate compatibility mouse messages for a primary touch contact in
applications that do not process pointer input. See Microsoft's pointer flags:
https://learn.microsoft.com/en-us/windows/win32/inputmsg/pointer-flags-contants
Do not disable system-wide compatibility or pretend mouse frames are touch.

The existing local diagnostics now include:

- control.lastOpenRequest: requested format and inputTypes.
- control.receivedTouchSamples / receivedMouseSamples: decoded source input counts.
- control.lastReceivedInput: stream/sequence/cursor/typeByte/inputType and the last
  up to 10 Touch records in wire contact IDs and normalized coordinates.
- nativeInput.lastSubmission: local action type, native-confirmed type/API/pointer
  type and up to 10 native records, after local contact-ID and physical mapping.
  Native confirmation is null while pending, rejected or unknown rather than
  inventing proof that an API was called. These records never include lease IDs.

For successful Windows Touch, expect nativeInputType:touch,
nativeApi:InjectTouchInput, pointerType:PT_TOUCH. Mouse-looking behavior after that
must be checked in the destination's WM_POINTER/GetPointerInfo or browser pointer
handlers; metadata alone does not prove that an arbitrary target handled Touch.
The explicit owned-window test checks actual GetPointerInfo PT_TOUCH receipt,
in addition to the native command result metadata.

These additions are bounded local diagnostics and do not alter AXTP framing,
wire data, authorization, coalescing rules or input injection behavior. Current
Windows typed input remains Touch only. The native backend Mouse implementation
is retained but is not a negotiated fallback. No live TX window was open when this
turn inspected running windows; new per-packet type evidence must be collected in
the supplied diagnostic build rather than claimed from static source inspection.
