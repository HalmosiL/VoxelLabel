import { useRef, useState } from "react";
import { FlyAnalog, stickVector } from "../lib/volumeRender";

const RADIUS = 44;

/** Flying on a touch screen: a stick bottom left, above the picked point's
 * note (push to move, as far as it is pushed), rise and sink buttons
 * bottom right. Dragging anywhere else on the view looks around
 * (VolumeView), so a thumb on each side flies like a game pad. Writes into `analog`, which the frame loop reads. */
export default function TouchFlyPad({ analog }: { analog: FlyAnalog }) {
  const [knob, setKnob] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const origin = useRef<{ id: number; x: number; y: number } | null>(null);

  const release = () => {
    origin.current = null;
    analog.forward = 0;
    analog.right = 0;
    setKnob({ x: 0, y: 0 });
  };
  const hold = (up: number) => ({
    onPointerDown: (e: React.PointerEvent) => {
      e.currentTarget.setPointerCapture(e.pointerId);
      analog.up = up;
    },
    onPointerUp: () => (analog.up = 0),
    onPointerCancel: () => (analog.up = 0),
  });

  return (
    <>
      <div
        className="absolute bottom-20 left-4 z-10 rounded-full border border-white/30 bg-black/40"
        style={{ width: RADIUS * 2, height: RADIUS * 2, touchAction: "none" }}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          const r = e.currentTarget.getBoundingClientRect();
          origin.current = { id: e.pointerId, x: r.left + r.width / 2, y: r.top + r.height / 2 };
        }}
        onPointerMove={(e) => {
          const o = origin.current;
          if (!o || o.id !== e.pointerId) return;
          const push = stickVector(e.clientX - o.x, e.clientY - o.y, RADIUS);
          analog.forward = push.forward;
          analog.right = push.right;
          setKnob({ x: push.right * RADIUS, y: -push.forward * RADIUS });
        }}
        onPointerUp={release}
        onPointerCancel={release}
        title="Push to fly: forward, back and to the sides"
        data-testid="volume-stick"
      >
        <div
          className="pointer-events-none absolute rounded-full bg-white/60"
          style={{ width: 36, height: 36, left: RADIUS - 18 + knob.x, top: RADIUS - 18 + knob.y }}
          data-testid="volume-stick-knob"
        />
      </div>
      <div className="absolute bottom-8 right-4 z-10 flex flex-col gap-2" style={{ touchAction: "none" }}>
        <button type="button" className="h-11 w-11 rounded-full border border-white/30 bg-black/40 text-lg text-white" title="Rise (Space)" data-testid="volume-rise" {...hold(1)}>
          ▲
        </button>
        <button type="button" className="h-11 w-11 rounded-full border border-white/30 bg-black/40 text-lg text-white" title="Sink (Shift)" data-testid="volume-sink" {...hold(-1)}>
          ▼
        </button>
      </div>
    </>
  );
}
