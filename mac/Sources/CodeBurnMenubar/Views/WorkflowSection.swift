import SwiftUI

/// Compact workflow-intelligence strip: one row of up to three stats plus one
/// coaching note. Reads whatever payload the store currently holds, so it
/// follows the selected agent tab automatically. Renders nothing when the
/// payload carries no workflow signal (older CLIs, or a period with nothing
/// measurable), so it never shows zero placeholders.
struct WorkflowSection: View {
    @Environment(AppStore.self) private var store

    var body: some View {
        let model = WorkflowStripModel(
            workflow: store.payload.current.workflow,
            topReworkedFiles: store.payload.current.topReworkedFiles
        )
        if !model.isEmpty {
            // Own the leading divider so the section slots into the popover's
            // divider rhythm and leaves no doubled line when it's hidden.
            VStack(spacing: 0) {
                Divider().opacity(0.5)
                VStack(alignment: .leading, spacing: 8) {
                    SectionCaption(text: "Workflow")
                    WorkflowStatRow(model: model)
                    if let note = model.note {
                        Text(note)
                            .font(.system(size: 11))
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .truncationMode(.tail)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 11)
            }
        }
    }
}

private enum WorkflowStat: Identifiable {
    case labeled(id: String, label: String, value: String)
    case reworked(name: String, sessions: Int)

    var id: String {
        switch self {
        case .labeled(let id, _, _): return id
        case .reworked: return "reworked"
        }
    }
}

private struct WorkflowStatRow: View {
    let model: WorkflowStripModel

    private var stats: [WorkflowStat] {
        var s: [WorkflowStat] = []
        if let corrections = model.corrections {
            s.append(.labeled(id: "corrections", label: "Corrections", value: corrections))
        }
        if let firstEdit = model.firstEdit {
            s.append(.labeled(id: "firstEdit", label: "First edit", value: firstEdit))
        }
        if let name = model.reworkedName, let sessions = model.reworkedSessions {
            s.append(.reworked(name: name, sessions: sessions))
        }
        return s
    }

    var body: some View {
        HStack(spacing: 7) {
            ForEach(Array(stats.enumerated()), id: \.element.id) { index, stat in
                if index > 0 {
                    Text("·")
                        .font(.system(size: 11))
                        .foregroundStyle(.tertiary)
                }
                WorkflowStatCell(stat: stat)
            }
            Spacer(minLength: 0)
        }
    }
}

private struct WorkflowStatCell: View {
    let stat: WorkflowStat

    var body: some View {
        HStack(spacing: 4) {
            switch stat {
            case .labeled(_, let label, let value):
                Text(label)
                    .font(.system(size: 11))
                    .foregroundStyle(.tertiary)
                Text(value)
                    .font(.codeMono(size: 12, weight: .medium))
                    .foregroundStyle(.primary)
                    .tracking(-0.2)
            case .reworked(let name, let sessions):
                Text(name)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Text("×\(sessions)")
                    .font(.codeMono(size: 11, weight: .medium))
                    .foregroundStyle(.secondary)
                    .tracking(-0.2)
            }
        }
    }
}
