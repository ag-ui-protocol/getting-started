// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import SwiftUI

struct AgentListView: View {
    let agents: [AgentConfig]
    let selectedId: String?
    let onSelect: (String?) -> Void
    let onAdd: () -> Void
    let onEdit: (AgentConfig) -> Void
    let onDelete: (String) -> Void

    var body: some View {
        List {
            ForEach(agents) { agent in
                AgentRow(
                    agent: agent,
                    isSelected: agent.id == selectedId,
                    onSelect: { onSelect(agent.id) },
                    onEdit: { onEdit(agent) },
                    onDelete: { onDelete(agent.id) }
                )
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle("Agents")
        .toolbar {
            ToolbarItem(placement: .navigationBarTrailing) {
                Button(action: onAdd) {
                    Label("Add Agent", systemImage: "plus")
                }
            }
        }
        .overlay {
            if agents.isEmpty {
                VStack(spacing: 16) {
                    Image(systemName: "person.crop.circle.badge.plus")
                        .font(.system(size: 40))
                        .foregroundStyle(.secondary)
                    Text("No agents")
                        .font(.headline)
                    Text("Tap + to add your first agent.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }
}

// MARK: - AgentRow

private struct AgentRow: View {
    let agent: AgentConfig
    let isSelected: Bool
    let onSelect: () -> Void
    let onEdit: () -> Void
    let onDelete: () -> Void

    var body: some View {
        Button(action: onSelect) {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text(agent.name)
                        .font(.headline)
                        .foregroundStyle(.primary)
                    Group {
                        if let desc = agent.description {
                            Text(desc)
                        } else {
                            Text(agent.url)
                        }
                    }
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                }
                Spacer()
                if isSelected {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundStyle(.cyan)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(agent.name)
        .accessibilityHint(isSelected ? "Selected. Tap to keep this agent active." : "Tap to select this agent")
        .swipeActions(edge: .trailing) {
            Button(role: .destructive, action: onDelete) {
                Label("Delete", systemImage: "trash")
            }
            Button(action: onEdit) {
                Label("Edit", systemImage: "pencil")
            }
            .tint(.blue)
        }
        .contextMenu {
            Button(action: onEdit) {
                Label("Edit", systemImage: "pencil")
            }
            Button(role: .destructive, action: onDelete) {
                Label("Delete", systemImage: "trash")
            }
        }
    }
}
