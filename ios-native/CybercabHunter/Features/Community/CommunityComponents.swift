import SwiftUI
import ImageIO

// MARK: - Images

/// Downloads through URLSession (so URLCache and the Worker's Cache-Control
/// apply) and decodes at the size it's shown, never the full photo for a
/// thumbnail. Decoded images are kept in memory for fast scrolling.
actor ImagePipeline {
    static let shared = ImagePipeline()
    private let cache = NSCache<NSString, UIImage>()
    private var inFlight: [String: Task<UIImage?, Never>] = [:]

    init() { cache.totalCostLimit = 64 << 20 }

    /// Forgets every decoded image (on sign-out, so no private photo outlives the session).
    func removeAll() { cache.removeAllObjects() }

    /// `token`: a moderator-only photo, fetched with the session (never stored on disk).
    func image(_ url: URL, maxPixel: Int, token: String? = nil) async -> UIImage? {
        let key = "\(url.absoluteString)#\(maxPixel)\(token == nil ? "" : "#auth")" as NSString
        if let hit = cache.object(forKey: key) { return hit }
        if let task = inFlight[key as String] { return await task.value }
        var request = URLRequest(url: url)
        if let token {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            request.cachePolicy = .reloadIgnoringLocalCacheData
        }
        let task = Task<UIImage?, Never> { [request] in
            guard let (data, response) = try? await URLSession.shared.data(for: request),
                  (response as? HTTPURLResponse).map({ (200..<300).contains($0.statusCode) }) ?? false else { return nil }
            return Self.downsample(data, maxPixel: maxPixel)
        }
        inFlight[key as String] = task
        let image = await task.value
        inFlight[key as String] = nil
        if let image { cache.setObject(image, forKey: key, cost: Int(image.size.width * image.size.height * image.scale * image.scale * 4)) }
        return image
    }

    static func downsample(_ data: Data, maxPixel: Int) -> UIImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary) else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixel
        ]
        return CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary).map { UIImage(cgImage: $0) }
    }
}

/// A remote picture decoded for `points` on its long side; a quiet tile while it loads.
struct RemoteImage: View {
    let url: URL?
    var points: CGFloat = 400
    var contentMode: ContentMode = .fill
    /// The session token, for moderator-only photos.
    var token: String? = nil
    @Environment(\.displayScale) private var scale
    @State private var image: UIImage?
    @State private var failed = false

    var body: some View {
        ZStack {
            if let image {
                Image(uiImage: image).resizable().aspectRatio(contentMode: contentMode)
            } else {
                Rectangle().fill(Color.chLine.opacity(0.6))
                    .overlay { if failed { Image(systemName: "photo").foregroundStyle(Color.chCaption) } }
            }
        }
        .task(id: url) {
            guard let url else { failed = true; return }
            image = await ImagePipeline.shared.image(url, maxPixel: Int(points * scale), token: token)
            failed = image == nil
        }
    }
}

// MARK: - People

/// A person's avatar as the website draws it (CCC.renderAvatar): their photo,
/// else their initials on a neutral tile; a private ("Anonymous") author gets
/// the default person icon and nothing of theirs.
struct PersonAvatar: View {
    let name: String
    let url: URL?
    var anonymous = false
    var size: CGFloat = 40

    var body: some View {
        Group {
            if anonymous {
                Image(systemName: "person").font(.system(size: size * 0.45, weight: .regular))
                    .foregroundStyle(Color.chFog)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(Color.chInk.opacity(0.06))
            } else if let url {
                RemoteImage(url: url, points: size)
            } else {
                Text(SocialAuthor.initials(name))
                    .font(.inter(size * 0.36, .bold))
                    .foregroundStyle(Color(hex: 0xF1F5F9))
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(Color(hex: 0x1E293B))
            }
        }
        .frame(width: size, height: size)
        .clipShape(Circle())
        .accessibilityHidden(true)
    }
}

extension PersonAvatar {
    init(_ author: SocialAuthor, size: CGFloat = 40) {
        self.init(name: author.name, url: author.anonymous ? nil : author.avatarURL, anonymous: author.anonymous, size: size)
    }
}

/// The Spotter rank colours (css/community.css .rank-*).
enum RankColor {
    static func color(_ key: String?) -> Color {
        switch key {
        case "bronze": Color(hex: 0xD08A4A)
        case "silver": Color(hex: 0xC3C9D2)
        case "gold": .brandGold
        case "platinum": Color(hex: 0xE6ECF2)
        case "diamond": Color(hex: 0xBFE6FF)
        default: .chFog
        }
    }
    /// "Bronze Spotter" → "bronze".
    static func key(fromName name: String) -> String { name.split(separator: " ").first.map { $0.lowercased() } ?? "" }
}

/// "Gold Spotter · Lv 12" beside a name (social.js rankHtml).
struct RankLevel: View {
    let rank: SpotterRank?
    let level: Int?
    var body: some View {
        if let rank {
            HStack(spacing: 5) {
                Text(rank.name).font(.inter(11.5, .bold)).foregroundStyle(RankColor.color(rank.key))
                if let level {
                    Text("Lv \(level)").font(.inter(11, .semibold)).foregroundStyle(Color.chFog)
                        .padding(.horizontal, 6).padding(.vertical, 1)
                        .overlay(Capsule().strokeBorder(Color.chInk.opacity(0.1)))
                }
            }
            .lineLimit(1)
        }
    }
}

/// The post type chip (css/community.css .social-cat).
struct CategoryChip: View {
    let category: String
    var body: some View {
        let (fg, bg) = Self.colors(category)
        Text((PostCategory(rawValue: category)?.title ?? "General").uppercased())
            .font(.inter(10.5, .bold)).tracking(0.4)
            .foregroundStyle(fg)
            .padding(.horizontal, 8).padding(.vertical, 3)
            .background(bg, in: .capsule)
    }
    static func colors(_ c: String) -> (Color, Color) {
        switch c {
        case "sighting": (.brandGold, Color.brandGold.opacity(0.12))
        case "review": (.chOK, Color.chOK.opacity(0.12))
        case "question": (Color(hex: 0x8AB4F8), Color(hex: 0x8AB4F8, opacity: 0.12))
        case "news": (Color(hex: 0xC4A7FF), Color(hex: 0xC4A7FF, opacity: 0.12))
        default: (.chMist, Color.chInk.opacity(0.06))
        }
    }
}

/// The site's section title with its gold icon ("SPOTTING STREAKS").
struct CommunityPanelTitle: View {
    let icon: String
    let title: String
    let intro: String
    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: icon).font(.system(size: 18, weight: .semibold)).foregroundStyle(Color.brandGold)
                .frame(width: 32, height: 32)
            VStack(alignment: .leading, spacing: 4) {
                Text(title).displayTitle(20)
                Text(intro).font(.inter(12)).foregroundStyle(Color.chCaption).fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

/// A gold sign-in prompt card (the site's .streak-signin).
struct SignInPrompt: View {
    let title: String
    let text: String
    @Environment(\.openSignIn) private var openSignIn
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title).font(.inter(16, .bold)).foregroundStyle(Color.chInk)
            Text(text).font(.inter(13)).foregroundStyle(Color.chFog).fixedSize(horizontal: false, vertical: true)
            Button("Sign in") { openSignIn() }
                .buttonStyle(GoldButtonStyle())
                .accessibilityIdentifier("signInPrompt")
        }
        .dataPanel()
    }
}

/// The site's gold pill button (.social-publish-btn).
struct GoldButtonStyle: ButtonStyle {
    var small = false
    @Environment(\.isEnabled) private var enabled
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.inter(small ? 13 : 14, .bold))
            .foregroundStyle(Color(hex: 0x1A1204))
            .padding(.horizontal, small ? 14 : 20).frame(minHeight: small ? 34 : 40)
            .background(Color.brandGold, in: .capsule)
            .opacity(enabled ? (configuration.isPressed ? 0.85 : 1) : 0.45)
    }
}

/// An outlined pill (filters, board tabs): white when selected, as the site's city-filter.
struct PillToggle: View {
    let title: String
    let selected: Bool
    var compact = false
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.inter(compact ? 12 : 13, .semibold))
                .lineLimit(1)
                .padding(.horizontal, compact ? 12 : 16).frame(minHeight: compact ? 34 : 38)
                .foregroundStyle(selected ? Color.chBackground : Color.chMist)
                .background(selected ? Color.chInk : Color.clear, in: .capsule)
                .overlay(Capsule().strokeBorder(selected ? Color.clear : Color.chHair2))
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

/// A short confirmation at the top of the screen (the website's toast).
struct ToastBanner: View {
    let text: String
    var isError = false
    var body: some View {
        Label(text, systemImage: isError ? "exclamationmark.circle.fill" : "checkmark.circle.fill")
            .font(.inter(13, .semibold))
            .foregroundStyle(isError ? Color(hex: 0xF08A84) : Color.chInk)
            .padding(.horizontal, 14).padding(.vertical, 10)
            .background(Color.chSurface2, in: .capsule)
            .overlay(Capsule().strokeBorder(isError ? Color(hex: 0xF08A84, opacity: 0.4) : Color.brandGold.opacity(0.35)))
            .shadow(color: .black.opacity(0.4), radius: 12, y: 6)
            .accessibilityIdentifier("toast")
    }
}

/// A toast bound to any screen's state, shown briefly at the top.
struct ToastHost: View {
    @Binding var toast: SocialFeedModel.Toast?
    var body: some View {
        Group {
            if let t = toast {
                ToastBanner(text: t.text, isError: t.isError)
                    .padding(.top, 8)
                    .transition(.move(edge: .top).combined(with: .opacity))
                    .task(id: t.id) {
                        try? await Task.sleep(for: .seconds(2.6))
                        if toast?.id == t.id { withAnimation { toast = nil } }
                    }
            }
        }
        .animation(.snappy, value: toast)
    }
}

// MARK: - Sign-in from anywhere

private struct OpenSignInKey: EnvironmentKey { static let defaultValue: @MainActor @Sendable () -> Void = {} }
extension EnvironmentValues {
    /// Opens the account sheet (Google sign-in); set by RootView.
    var openSignIn: @MainActor @Sendable () -> Void {
        get { self[OpenSignInKey.self] }
        set { self[OpenSignInKey.self] = newValue }
    }
}
