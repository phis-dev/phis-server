export type VerticalStepItem = {
  key: string;
  index: number;
  title: string;
  summary: string;
  status: "complete" | "current" | "upcoming";
  href?: string;
  statusLabel: string;
};

export function VerticalSteps({
  label,
  items,
}: {
  label: string;
  items: VerticalStepItem[];
}) {
  return (
    <nav className="ui-vertical-steps" aria-label={label}>
      <ol className="ui_vertical_steps_list">
        {items.map((item) => (
          <li
            key={item.key}
            className="ui_vertical_steps_item"
            data-status={item.status}
          >
            {item.href ? (
              <a className="ui_vertical_steps_link" href={item.href}>
                <span className="ui_vertical_steps_marker" aria-hidden="true">
                  <span className="ui_vertical_steps_dot">{item.index}</span>
                  <span className="ui_vertical_steps_line" />
                </span>
                <span className="ui_vertical_steps_body">
                  <span className="ui_vertical_steps_meta">{item.statusLabel}</span>
                  <span className="ui_vertical_steps_title">{item.title}</span>
                  <span className="ui_vertical_steps_summary">{item.summary}</span>
                </span>
              </a>
            ) : (
              <span className="ui_vertical_steps_link">
                <span className="ui_vertical_steps_marker" aria-hidden="true">
                  <span className="ui_vertical_steps_dot">{item.index}</span>
                  <span className="ui_vertical_steps_line" />
                </span>
                <span className="ui_vertical_steps_body">
                  <span className="ui_vertical_steps_meta">{item.statusLabel}</span>
                  <span className="ui_vertical_steps_title">{item.title}</span>
                  <span className="ui_vertical_steps_summary">{item.summary}</span>
                </span>
              </span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}
