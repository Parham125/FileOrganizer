type P = { className?: string };

const base = "h-[18px] w-[18px]";
function S({ className, children }: P & { children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className ?? base}
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export const IconSearch = (p: P) => (
  <S {...p}>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </S>
);

export const IconDuplicates = (p: P) => (
  <S {...p}>
    <rect x="8" y="8" width="12" height="12" rx="2" />
    <path d="M4 16V6a2 2 0 0 1 2-2h10" />
  </S>
);

export const IconTrash = (p: P) => (
  <S {...p}>
    <path d="M4 7h16" />
    <path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" />
    <path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12" />
  </S>
);

export const IconSettings = (p: P) => (
  <S {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9 17 7M7 17l-2.1 2.1" />
  </S>
);

export const IconFolder = (p: P) => (
  <S {...p}>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
  </S>
);

export const IconRestore = (p: P) => (
  <S {...p}>
    <path d="M4 5v5h5" />
    <path d="M4.5 10a8 8 0 1 1-1.2 5" />
  </S>
);

export const IconCheck = (p: P) => (
  <S {...p}>
    <path d="m5 12 4.5 4.5L19 7" />
  </S>
);

export const IconX = (p: P) => (
  <S {...p}>
    <path d="M6 6l12 12M18 6 6 18" />
  </S>
);

export const IconSun = (p: P) => (
  <S {...p}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4" />
  </S>
);

export const IconMoon = (p: P) => (
  <S {...p}>
    <path d="M20 14.5A8 8 0 0 1 9.5 4a7 7 0 1 0 10.5 10.5z" />
  </S>
);

export const IconSpark = (p: P) => (
  <S {...p}>
    <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" />
  </S>
);

export const IconInsights = (p: P) => (
  <S {...p}>
    <path d="M4 4v15a1 1 0 0 0 1 1h15" />
    <path d="M7.5 8h10" />
    <path d="M7.5 12.5h6.5" />
    <path d="M7.5 17h3.5" />
  </S>
);

export const IconOrganize = (p: P) => (
  <S {...p}>
    <path d="M3 6a2 2 0 0 1 2-2h3l1.5 1.5H19a2 2 0 0 1 2 2v2H3z" />
    <path d="M3 9.5h18l-1 8a2 2 0 0 1-2 1.8H6a2 2 0 0 1-2-1.8z" />
    <path d="M9 14h6" />
  </S>
);

export const IconRules = (p: P) => (
  <S {...p}>
    <path d="M3.5 5h17l-6.5 7.5V19l-4 2v-8.5z" />
  </S>
);

export const IconPlay = (p: P) => (
  <S {...p}>
    <path d="M7 4.8v14.4l12-7.2z" />
  </S>
);

export const IconAssistant = (p: P) => (
  <S {...p}>
    <path d="M4 5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H9l-4 3.5V16H6a2 2 0 0 1-2-2z" />
    <path d="M12 6.5l.9 2.6 2.6.9-2.6.9-.9 2.6-.9-2.6-2.6-.9 2.6-.9z" />
  </S>
);

export const IconReveal = (p: P) => (
  <S {...p}>
    <path d="M14 4h6v6" />
    <path d="M20 4 12 12" />
    <path d="M18 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5" />
  </S>
);

export const IconSend = (p: P) => (
  <S {...p}>
    <path d="M5 12h13" />
    <path d="m12 5 7 7-7 7" />
  </S>
);

export const IconHistory = (p: P) => (
  <S {...p}>
    <path d="M3.5 5.5v4.5H8" />
    <path d="M4 10a8 8 0 1 1 1 5" />
    <path d="M12 8v4.5l3 1.8" />
  </S>
);

export const IconPencil = (p: P) => (
  <S {...p}>
    <path d="M4 20h4L19.5 8.5a2 2 0 0 0 0-2.8l-1.2-1.2a2 2 0 0 0-2.8 0L4 16z" />
    <path d="M14.5 6.5 17.5 9.5" />
  </S>
);

export const IconBranch = (p: P) => (
  <S {...p}>
    <path d="M6 5v14" />
    <circle cx="17" cy="7" r="2.5" />
    <path d="M6 12h5a4 4 0 0 0 4-4v-.5" />
  </S>
);

export const IconKey = (p: P) => (
  <S {...p}>
    <circle cx="8" cy="12" r="4" />
    <path d="M11 12h9" />
    <path d="M17 12v3M20 12v2" />
  </S>
);
