import SwiftUI

/// Report a post or comment (the website's report dialog): one of the six
/// reasons, optional details (500 characters). The server allows one report
/// per item per rider and 20 a day; its answer is shown as the site words it.
struct ReportSheet: View {
    let kind: String          // "post" or "comment"
    let id: String
    let social: SocialFeedModel
    @Environment(\.dismiss) private var dismiss
    @State private var reason: ReportReason?
    @State private var details = ""
    @State private var sending = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    ForEach(ReportReason.allCases) { r in
                        Button { reason = r } label: {
                            HStack {
                                Text(r.title).foregroundStyle(Color.chInk)
                                Spacer()
                                if reason == r { Image(systemName: "checkmark").foregroundStyle(Color.brandGold) }
                            }
                        }
                        .accessibilityAddTraits(reason == r ? .isSelected : [])
                    }
                } header: { Text("Reason") } footer: { Text("Moderators review every report.") }
                Section("Details (optional)") {
                    TextField("What should moderators know?", text: $details, axis: .vertical)
                        .lineLimit(3...6)
                        .onChange(of: details) { if details.count > 500 { details = String(details.prefix(500)) } }
                }
                if let error {
                    Section { Text(error).foregroundStyle(Color(hex: 0xF08A84)).accessibilityIdentifier("reportError") }
                }
            }
            .font(.inter(15))
            .scrollContentBackground(.hidden)
            .background(Color.chSurface2)
            .navigationTitle(kind == "post" ? "Report post" : "Report comment")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Send report") { send() }.disabled(reason == nil || sending).fontWeight(.semibold)
                }
            }
        }
        .presentationDetents([.medium, .large])
    }

    private func send() {
        guard let reason, !sending else { return }
        sending = true
        Task {
            let failure = await social.report(kind, id: id, reason: reason, details: details)
            sending = false
            if let failure { error = failure } else { dismiss() }
        }
    }
}
