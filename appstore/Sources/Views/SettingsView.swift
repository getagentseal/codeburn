import SwiftUI

struct SettingsView: View {
    @ObservedObject var store: SessionStore

    var body: some View {
        Form {
            Section("Folder Access") {
                ForEach(store.grantedFolders, id: \.absoluteString) { url in
                    HStack {
                        Image(systemName: "folder")
                        Text(url.path.replacingOccurrences(of: FileManager.default.homeDirectoryForCurrentUser.path, with: "~"))
                    }
                }

                Button("Add Folder...") {
                    store.grantFolderAccess()
                }
            }

            Section("About") {
                LabeledContent("Version", value: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "—")
                LabeledContent("Providers Found", value: "\(store.providers.count)")
            }
        }
        .formStyle(.grouped)
        .frame(width: 400, height: 300)
    }
}
