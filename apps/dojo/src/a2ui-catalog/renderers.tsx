"use client";

import React, { useState } from "react";
import { createReactComponent } from "@copilotkit/a2ui-renderer";
import {
  RowApi,
  FlightCardApi,
  HotelCardApi,
  ProductCardApi,
  TeamMemberCardApi,
  StarRatingApi,
} from "./apis";

// ─── Shared helpers ──────────────────────────────────────────────────

// Theme-aware colors using CSS variables with fallbacks
const c = {
  card: "hsl(var(--card, 0 0% 100%))",
  cardFg: "hsl(var(--card-foreground, 222 47% 11%))",
  border: "hsl(var(--border, 220 13% 91%))",
  muted: "hsl(var(--muted-foreground, 215 16% 47%))",
  bg: "hsl(var(--background, 0 0% 100%))",
};

const cardStyle: React.CSSProperties = {
  border: `1px solid ${c.border}`,
  borderRadius: "16px",
  padding: "20px",
  background: c.card,
  color: c.cardFg,
  minWidth: 260,
  maxWidth: 340,
  flex: "1 1 260px",
  display: "flex",
  flexDirection: "column",
  gap: "12px",
  boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
};

function ActionButton({
  label,
  doneLabel,
  action,
}: {
  label: string;
  doneLabel: string;
  action?: () => void;
}) {
  const [done, setDone] = useState(false);
  return (
    <button
      disabled={done}
      style={{
        width: "100%",
        padding: "10px",
        borderRadius: "10px",
        border: done ? "1px solid #d1fae5" : `1px solid ${c.border}`,
        background: done ? "hsl(var(--card, 0 0% 100%))" : c.card,
        color: done ? "#059669" : c.cardFg,
        fontSize: "0.85rem",
        fontWeight: 500,
        cursor: done ? "default" : "pointer",
        transition: "all 0.2s ease",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: "6px",
      }}
      onClick={() => {
        if (!done) {
          action?.();
          setDone(true);
        }
      }}
    >
      {done && (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#059669" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      )}
      {done ? doneLabel : label}
    </button>
  );
}

function Stars({ value, max = 5 }: { value: number; max?: number }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "2px" }}>
      {Array.from({ length: max }, (_, i) => {
        const fill = Math.min(1, Math.max(0, value - i));
        return (
          <svg key={i} width="16" height="16" viewBox="0 0 24 24">
            <path
              d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"
              fill="#e5e7eb"
            />
            <defs>
              <clipPath id={`sc-${i}-${value}`}>
                <rect x="0" y="0" width={24 * fill} height="24" />
              </clipPath>
            </defs>
            <path
              d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"
              fill="#f59e0b"
              clipPath={`url(#sc-${i}-${value})`}
            />
          </svg>
        );
      })}
      <span style={{ fontSize: "0.8rem", fontWeight: 600, color: c.cardFg, marginLeft: "4px" }}>
        {value.toFixed(1)}
      </span>
    </div>
  );
}

// ─── Row ─────────────────────────────────────────────────────────────

// A Row child is either a bare component id or a reference carrying its own
// data path.
type RowChild = string | { id: string; basePath?: string };

export const Row = createReactComponent(RowApi, ({ props, buildChild }) => {
  const items = Array.isArray(props.children) ? props.children : [];
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "row",
        gap: `${props.gap ?? 24}px`,
        alignItems: "stretch",
        overflowX: "auto",
        width: "100%",
      }}
    >
      {items.map((item: RowChild, i: number) => {
        if (typeof item === "string")
          return <div key={`${item}-${i}`} style={{ flexShrink: 0, display: "flex" }}>{buildChild(item)}</div>;
        if (item && typeof item === "object" && "id" in item)
          return <div key={`${item.id}-${i}`} style={{ flexShrink: 0, display: "flex" }}>{buildChild(item.id, item.basePath)}</div>;
        return null;
      })}
    </div>
  );
});

// ─── FlightCard ──────────────────────────────────────────────────────

export const FlightCard = createReactComponent(FlightCardApi, ({ props }) => {
  const statusColors: Record<string, string> = {
    "On Time": "#22c55e",
    Delayed: "#eab308",
    Cancelled: "#ef4444",
  };
  const dotColor = statusColors[props.status as string] ?? "#22c55e";

  return (
    <div style={cardStyle}>
      {/* Header: airline + price */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          {/* DEFERRED (PNI-307): plain <img> kept to preserve the exact
              request and layout semantics for this agent-provided remote URL;
              converting to next/image (sizing, loading and src handling
              differ) is out of scope for this behavior-preserving pass. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={props.airlineLogo as string}
            alt={props.airline as string}
            style={{ width: 28, height: 28, borderRadius: "50%", objectFit: "contain" }}
          />
          <span style={{ fontWeight: 600, fontSize: "0.95rem" }}>{props.airline as string}</span>
        </div>
        <span style={{ fontWeight: 700, fontSize: "1.15rem", color: c.cardFg }}>{props.price as string}</span>
      </div>

      {/* Meta */}
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.8rem", color: c.muted }}>
        <span>{props.flightNumber as string}</span>
        <span>{props.date as string}</span>
      </div>

      <hr style={{ border: "none", borderTop: `1px solid ${c.border}`, margin: 0 }} />

      {/* Times */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontWeight: 700, fontSize: "1.1rem" }}>{props.departureTime as string}</span>
        <span style={{ fontSize: "0.75rem", color: c.muted }}>{props.duration as string}</span>
        <span style={{ fontWeight: 700, fontSize: "1.1rem" }}>{props.arrivalTime as string}</span>
      </div>

      {/* Route */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: "0.95rem", fontWeight: 600, color: c.cardFg }}>
        <span>{props.origin as string}</span>
        <span style={{ color: c.muted }}>→</span>
        <span>{props.destination as string}</span>
      </div>

      <div style={{ marginTop: "auto", display: "flex", flexDirection: "column", gap: "12px" }}>
        <hr style={{ border: "none", borderTop: `1px solid ${c.border}`, margin: 0 }} />

        {/* Status */}
        <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: dotColor, display: "inline-block" }} />
          <span style={{ fontSize: "0.8rem", color: c.muted }}>{props.status as string}</span>
        </div>

        <ActionButton label="Select" doneLabel="Selected" action={props.action} />
      </div>
    </div>
  );
});

// ─── HotelCard ───────────────────────────────────────────────────────

export const HotelCard = createReactComponent(HotelCardApi, ({ props }) => {
  const rating = typeof props.rating === "number" ? props.rating : 0;
  return (
    <div style={cardStyle}>
      <span style={{ fontWeight: 700, fontSize: "1.05rem", color: c.cardFg }}>{props.name as string}</span>
      <span style={{ fontSize: "0.8rem", color: c.muted }}>{props.location as string}</span>

      <Stars value={rating} />

      {props.amenities && (
        <span style={{ fontSize: "0.75rem", color: c.muted, lineHeight: 1.4 }}>{props.amenities as string}</span>
      )}

      <div style={{ marginTop: "auto", display: "flex", flexDirection: "column", gap: "12px" }}>
        <hr style={{ border: "none", borderTop: `1px solid ${c.border}`, margin: 0 }} />

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontSize: "0.75rem", color: c.muted }}>per night</span>
          <span style={{ fontWeight: 700, fontSize: "1.15rem", color: c.cardFg }}>{props.pricePerNight as string}</span>
        </div>

        <ActionButton label="Book" doneLabel="Booked" action={props.action} />
      </div>
    </div>
  );
});

// ─── ProductCard ─────────────────────────────────────────────────────

export const ProductCard = createReactComponent(ProductCardApi, ({ props }) => {
  const rating = typeof props.rating === "number" ? props.rating : 0;
  return (
    <div style={cardStyle}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontWeight: 700, fontSize: "1rem", color: c.cardFg }}>{props.name as string}</span>
        {props.badge && (
          <span style={{
            fontSize: "0.65rem", fontWeight: 500, background: "#dbeafe", color: "#1e40af",
            padding: "2px 8px", borderRadius: "9999px", whiteSpace: "nowrap",
          }}>
            {props.badge as string}
          </span>
        )}
      </div>

      <Stars value={rating} />

      {props.description && (
        <span style={{ fontSize: "0.8rem", color: c.muted, lineHeight: 1.4 }}>{props.description as string}</span>
      )}

      <div style={{ marginTop: "auto", display: "flex", flexDirection: "column", gap: "12px" }}>
        <hr style={{ border: "none", borderTop: `1px solid ${c.border}`, margin: 0 }} />

        <span style={{ fontWeight: 700, fontSize: "1.15rem", color: c.cardFg }}>{props.price as string}</span>

        <ActionButton label="Select" doneLabel="Selected" action={props.action} />
      </div>
    </div>
  );
});

// ─── TeamMemberCard ──────────────────────────────────────────────────

export const TeamMemberCard = createReactComponent(TeamMemberCardApi, ({ props }) => {
  const initials = String(props.name)
    .split(" ")
    .map((w) => w[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);

  return (
    <div style={cardStyle}>
      <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
        {props.avatarUrl ? (
          /* DEFERRED (PNI-307): plain <img> kept — agent-provided remote URL;
             see the flight-card note above. */
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={props.avatarUrl as string}
            alt={props.name as string}
            style={{ width: 48, height: 48, borderRadius: "50%", objectFit: "cover", flexShrink: 0 }}
          />
        ) : (
          <div style={{
            width: 48, height: 48, borderRadius: "50%", background: "#e0e7ff",
            display: "flex", alignItems: "center", justifyContent: "center",
            fontWeight: 600, fontSize: "0.9rem", color: "#4338ca", flexShrink: 0,
          }}>
            {initials}
          </div>
        )}
        <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
          <span style={{ fontWeight: 600, fontSize: "0.95rem", color: c.cardFg }}>{props.name as string}</span>
          <span style={{ fontSize: "0.8rem", color: c.muted }}>{props.role as string}</span>
        </div>
      </div>

      {props.department && (
        <span style={{
          display: "inline-block", fontSize: "0.7rem", fontWeight: 500,
          background: "#f3f4f6", color: c.cardFg, padding: "3px 10px",
          borderRadius: "9999px", alignSelf: "flex-start",
        }}>
          {props.department as string}
        </span>
      )}

      {props.email && (
        <span style={{ fontSize: "0.8rem", color: c.muted }}>{props.email as string}</span>
      )}

      <div style={{ marginTop: "auto" }}>
        <ActionButton label="Contact" doneLabel="Contacted" action={props.action} />
      </div>
    </div>
  );
});

// ─── StarRating (standalone, used by fixed schema) ───────────────────

export const StarRating = createReactComponent(StarRatingApi, ({ props }) => {
  const value = typeof props.value === "number" ? props.value : 0;
  const maxStars = props.maxStars ?? 5;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
      {props.label && (
        <span style={{ fontSize: "0.7rem", fontWeight: 500, color: c.muted, textTransform: "uppercase", letterSpacing: "0.05em" }}>
          {props.label as string}
        </span>
      )}
      <Stars value={value} max={maxStars} />
    </div>
  );
});
