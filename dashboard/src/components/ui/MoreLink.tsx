import { Link } from "react-router-dom";

interface MoreLinkProps {
  to: string;
  label?: string;
}

export function MoreLink({ to, label = "View more" }: MoreLinkProps) {
  return (
    <Link to={to} className="more-link">
      {label}
      <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        <path d="M9 18l6-6-6-6" />
      </svg>
    </Link>
  );
}
