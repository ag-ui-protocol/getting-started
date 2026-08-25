const SCARF_PIXEL_ID = "1c040678-b704-471e-a3f5-69c6bf52b703";

export function ScarfPixel() {
  return (
    // PERMANENT (PNI-307): analytics tracking pixel — kept a plain <img> so
    // the request to scarf.sh keeps the browser's exact default semantics
    // (referrer policy included); this exemption is not expected to be
    // retired.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      referrerPolicy="no-referrer-when-downgrade"
      src={`https://static.scarf.sh/a.png?x-pxid=${SCARF_PIXEL_ID}`}
      alt=""
      aria-hidden="true"
      className="absolute top-0 left-0"
    />
  );
}
