import SwiftUI

/// One Social post, as the website draws it (public/js/social.js postHtml,
/// css/community.css .social-post): pinned label, author with Spotter rank and
/// level, time, category, text with links, ride review, photos, the attached
/// registry vehicle, a link card, and like / comments / share / save. The ⋯
/// menu offers only what the server allows (can_edit, can_pin, mine, moderator).
struct PostCard: View {
    let post: SocialPost
    let social: SocialFeedModel
    /// The post's own screen (no "open" tap, full text).
    var single = false

    @Environment(SessionStore.self) private var session
    @Environment(AppRouter.self) private var router
    @Environment(\.openSignIn) private var openSignIn
    @State private var confirmDelete = false
    @State private var removing = false
    @State private var removeReason = ""
    @State private var reporting = false
    @State private var editing = false
    @State private var viewer: PhotoViewerItem?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if post.removed {
                Text("Removed by moderators. Only moderators can see this.")
                    .font(.inter(12, .semibold)).foregroundStyle(Color(hex: 0xF08A84))
                    .padding(.horizontal, 10).padding(.vertical, 6)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.chDanger.opacity(0.08), in: .rect(cornerRadius: 8))
            }
            if post.pinned {
                Label("Pinned", systemImage: "pin.fill").font(.inter(12, .bold)).foregroundStyle(Color.brandGold)
                    .padding(.leading, 44)
            }
            HStack(alignment: .top, spacing: 10) {
                authorAvatar
                VStack(alignment: .leading, spacing: 8) {
                    header
                    if !post.body.isEmpty {
                        LinkedText(text: post.body, size: single ? 15.5 : 14.5)
                            .accessibilityIdentifier("postBody")
                    }
                    if let review = post.review { ReviewBox(review: review) }
                    if !post.photos.isEmpty {
                        PhotoGrid(photos: post.photos) { viewer = PhotoViewerItem(photos: post.photos, index: $0) }
                    }
                    if let vehicle = post.vehicle {
                        Button { router.communityPath.append(vehicle.route) } label: { VehicleAttachmentCard(vehicle: vehicle, showsChevron: true) }
                            .buttonStyle(.plain)
                            .accessibilityLabel("Open Cybercab \(vehicle.licensePlate ?? vehicle.shortId ?? "") in the registry")
                            .accessibilityIdentifier("postVehicle")
                    }
                    if let link = post.linkURL { LinkCard(url: link) }
                    actions
                }
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.chSurface, in: .rect(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(post.pinned ? Color.brandGold.opacity(0.3) : Color.chInk.opacity(0.08)))
        .contentShape(.rect(cornerRadius: 12))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("post-\(post.id)")
        .accessibilityAction(named: "Open post") { open() }
        .confirmationDialog("Delete this post?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Delete post", role: .destructive) { Task { _ = await social.delete(post.id, asModerator: false) } }
        } message: { Text("Its photos, likes and comments go with it. This cannot be undone.") }
        .alert("Remove this post for everyone?", isPresented: $removing) {
            TextField("Note for the moderation log (optional)", text: $removeReason)
            Button("Remove", role: .destructive) { Task { _ = await social.delete(post.id, asModerator: true, reason: removeReason.isEmpty ? nil : removeReason) } }
            Button("Cancel", role: .cancel) {}
        }
        .sheet(isPresented: $reporting) { ReportSheet(kind: "post", id: post.id, social: social) }
        .sheet(isPresented: $editing) { ComposerView(social: social, editing: post) }
        .fullScreenCover(item: $viewer) { PhotoViewer(item: $0) }
    }

    @ViewBuilder private var authorAvatar: some View {
        if let handle = post.author.handle, !post.author.anonymous {
            Button { router.communityPath.append(RiderRoute(handle: handle)) } label: { PersonAvatar(post.author, size: 34) }
                .buttonStyle(.plain)
        } else {
            PersonAvatar(post.author, size: 34)
        }
    }

    private var header: some View {
        HStack(alignment: .top, spacing: 8) {
            VStack(alignment: .leading, spacing: 3) {
                AuthorName(author: post.author)
                HStack(spacing: 5) {
                    RankLevel(rank: post.author.rank, level: post.author.level)
                    if post.author.rank != nil { Text("·").foregroundStyle(Color.chSmoke) }
                    Button(action: open) {
                        Text(SocialText.relative(post.createdAt) + (post.editedAt != nil ? " · edited" : ""))
                            .font(.inter(12.5)).foregroundStyle(Color.chCaption)
                    }
                    .buttonStyle(.plain)
                    .disabled(single)
                    .accessibilityLabel(SocialText.fullTime(post.createdAt) + (post.editedAt != nil ? ", edited" : ""))
                }
            }
            Spacer(minLength: 4)
            CategoryChip(category: post.category)
            menu
        }
    }

    private var menu: some View {
        Menu {
            if post.canEdit { Button("Edit post", systemImage: "pencil") { editing = true } }
            if post.mine { Button("Delete post", systemImage: "trash", role: .destructive) { confirmDelete = true } }
            Button("Copy link", systemImage: "link") { UIPasteboard.general.url = post.webURL; social.show("Link copied.") }
            if !post.mine && !post.removed {
                Button("Report post", systemImage: "flag") { if social.viewer.signedIn { reporting = true } else { openSignIn() } }
            }
            if post.canPin {
                Button(post.pinned ? "Unpin from top" : "Pin to top of Social", systemImage: post.pinned ? "pin.slash" : "pin") {
                    Task { await social.setPinned(post.id, !post.pinned) }
                }
            }
            if social.viewer.moderator && !post.mine && !post.removed {
                Button("Remove (moderator)", systemImage: "eye.slash", role: .destructive) { removeReason = ""; removing = true }
            }
        } label: {
            Image(systemName: "ellipsis").font(.system(size: 15, weight: .semibold)).foregroundStyle(Color.chFog)
                .frame(width: 32, height: 28).contentShape(Rectangle())
        }
        .accessibilityLabel("Post options")
        .accessibilityIdentifier("postMenu")
    }

    private var actions: some View {
        HStack(spacing: 4) {
            Button {
                guard social.viewer.signedIn else { openSignIn(); return }
                Task { await social.toggleLike(post.id) }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: post.liked ? "heart.fill" : "heart")
                        .foregroundStyle(post.liked ? Color(hex: 0xF0567A) : Color.chFog)
                        .symbolEffect(.bounce, value: post.liked)
                    Text(Format.int(post.likeCount)).contentTransition(.numericText(value: Double(post.likeCount)))
                }
                .actionPill()
            }
            .accessibilityLabel(post.liked ? "Unlike, \(post.likeCount) likes" : "Like, \(post.likeCount) likes")
            .accessibilityIdentifier("likeButton")
            Button(action: open) {
                HStack(spacing: 6) { Image(systemName: "bubble.left"); Text(Format.int(post.commentCount)) }.actionPill()
            }
            .accessibilityLabel("Comments, \(post.commentCount)")
            .accessibilityIdentifier("commentsButton")
            ShareLink(item: post.webURL, subject: Text("Cybercab Hunter Community"), message: Text(String(post.body.prefix(100)))) {
                Image(systemName: "square.and.arrow.up").actionPill()
            }
            .accessibilityLabel("Share post")
            Spacer()
            Button {
                guard social.viewer.signedIn else { openSignIn(); return }
                Task { await social.toggleSave(post.id) }
            } label: {
                Image(systemName: post.saved ? "bookmark.fill" : "bookmark")
                    .foregroundStyle(post.saved ? Color.brandGold : Color.chFog)
                    .actionPill()
            }
            .accessibilityLabel(post.saved ? "Remove from saved" : "Save post")
            .accessibilityIdentifier("saveButton")
        }
        .buttonStyle(.plain)
        .font(.inter(13, .semibold))
        .monospacedDigit()
        .foregroundStyle(Color.chFog)
        .padding(.leading, -8)
        .sensoryFeedback(.impact(weight: .light), trigger: post.liked)
    }

    private func open() {
        guard !single else { return }
        router.communityPath.append(PostRoute(id: post.id))
    }
}

private extension View {
    func actionPill() -> some View {
        self.padding(.horizontal, 10).frame(minHeight: 36).contentShape(Capsule())
    }
}

/// The author's name: a link to their public profile when they have one.
struct AuthorName: View {
    let author: SocialAuthor
    var size: CGFloat = 14
    @Environment(AppRouter.self) private var router
    var body: some View {
        if let handle = author.handle, !author.anonymous {
            Button { router.communityPath.append(RiderRoute(handle: handle)) } label: {
                Text(author.name).font(.inter(size, .bold)).foregroundStyle(Color.chInk).lineLimit(1)
            }
            .buttonStyle(.plain)
            .accessibilityHint("Opens \(author.name)'s profile")
        } else {
            Text(author.name).font(.inter(size, .bold)).foregroundStyle(Color.chInk).lineLimit(1)
        }
    }
}

/// Text with its web addresses as links (the website's setLinkedText: only
/// http(s) addresses, trailing punctuation left out). Site links open natively.
struct LinkedText: View {
    let text: String
    var size: CGFloat = 14.5
    var color: Color = Color(hex: 0xD8DDE5)

    var body: some View {
        Text(Self.attributed(text))
            .font(.inter(size))
            .foregroundStyle(color)
            .tint(.brandGold)
            .lineSpacing(size * 0.25)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
            .textSelection(.enabled)
    }

    nonisolated static func attributed(_ text: String) -> AttributedString {
        var out = AttributedString()
        let ns = text as NSString
        let regex = try? NSRegularExpression(pattern: #"\bhttps?://[^\s<>"']+"#, options: [.caseInsensitive])
        var last = 0
        for m in regex?.matches(in: text, range: NSRange(location: 0, length: ns.length)) ?? [] {
            var raw = ns.substring(with: m.range)
            while let c = raw.last, ".,;:!?)]".contains(c) { raw.removeLast() }
            if m.range.location > last { out += AttributedString(ns.substring(with: NSRange(location: last, length: m.range.location - last))) }
            var link = AttributedString(raw)
            if let url = URL(string: raw) { link.link = url; link.underlineStyle = .single }
            out += link
            last = m.range.location + (raw as NSString).length
        }
        if last < ns.length { out += AttributedString(ns.substring(from: last)) }
        return out
    }
}

/// The ride review box (css .social-review).
struct ReviewBox: View {
    let review: SocialReview
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text("RIDE REVIEW").font(.inter(11, .bold)).tracking(0.6).foregroundStyle(Color.chFog)
                Spacer()
                Text(SocialText.stars(review.rating)).font(.system(size: 16)).tracking(1.2).foregroundStyle(Color.brandGold)
                    .accessibilityLabel("\(review.rating) out of 5 stars")
            }
            let facts = SocialText.reviewFacts(review)
            if !facts.isEmpty {
                Text(facts.joined(separator: "  ·  ")).font(.inter(12.5)).foregroundStyle(Color.chMist)
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 10)
        .background(Color.brandGold.opacity(0.05), in: .rect(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Color.brandGold.opacity(0.2)))
        .accessibilityElement(children: .combine)
    }
}

/// An attached registry vehicle (css .social-vcard): the site's generic
/// Cybercab picture (never this car), plate, CYBERCAB, "In the registry", VIN,
/// city and id. A registry link, not a verified sighting.
struct VehicleAttachmentCard: View {
    let vehicle: SocialVehicle
    var showsChevron = false
    var body: some View {
        HStack(spacing: 10) {
            if vehicle.image != nil {
                Image("CybercabRender").resizable().scaledToFit().frame(width: 52, height: 32).accessibilityHidden(true)
            } else {
                Image(systemName: "car.fill").foregroundStyle(Color.brandGold).frame(width: 40, height: 40)
                    .background(Color.chInk.opacity(0.05), in: .rect(cornerRadius: 10))
            }
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 8) {
                    Text(vehicle.licensePlate ?? "Plate unknown").font(.inter(14, .bold)).tracking(0.5).foregroundStyle(Color.chInk)
                        .lineLimit(1).fixedSize()
                    if vehicle.cybercab {
                        Text("CYBERCAB").font(.inter(10, .bold)).tracking(0.5).foregroundStyle(Color(hex: 0x1A1204))
                            .padding(.horizontal, 7).padding(.vertical, 2).background(Color.brandGold, in: .capsule)
                            .fixedSize()
                    }
                }
                Label("In the registry", systemImage: "checkmark").font(.inter(11, .semibold)).foregroundStyle(Color.chOK)
                    .labelStyle(TightLabel())
                HStack(spacing: 10) {
                    if let vin = vehicle.vin { fact("VIN", vin, mono: true) }
                    if let area = vehicle.serviceArea { Text(area).font(.inter(12)).foregroundStyle(Color.chFog) }
                    fact("ID", vehicle.shortId ?? String(vehicle.id.prefix(8)), mono: true)
                }
                .lineLimit(1)
            }
            Spacer(minLength: 0)
            if showsChevron { Image(systemName: "chevron.right").font(.system(size: 14, weight: .semibold)).foregroundStyle(Color.brandGold) }
        }
        .padding(.horizontal, 10).padding(.vertical, 9)
        .background {
            RoundedRectangle(cornerRadius: 12).fill(Color.chBackground)
                .overlay(RoundedRectangle(cornerRadius: 12).fill(LinearGradient(colors: [Color.brandGold.opacity(0.07), .clear], startPoint: .leading, endPoint: UnitPoint(x: 0.7, y: 0.5))))
        }
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Color.brandGold.opacity(0.28)))
        .contentShape(.rect(cornerRadius: 12))
    }

    private func fact(_ k: String, _ v: String, mono: Bool) -> some View {
        HStack(spacing: 4) {
            Text(k).font(.inter(10.5, .bold)).foregroundStyle(Color.chCaption)
            Text(v).font(mono ? .geistMono(11.5) : .inter(12)).foregroundStyle(Color.chFog).truncationMode(.middle)
        }
    }
}

private struct TightLabel: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 3) { configuration.icon.font(.system(size: 9, weight: .bold)); configuration.title }
    }
}

/// An attached article link (css .social-linkcard).
struct LinkCard: View {
    let url: URL
    @Environment(\.openURL) private var openURL
    var body: some View {
        Button { openURL(url) } label: {
            HStack(spacing: 10) {
                Image(systemName: "link").foregroundStyle(Color.brandGold)
                VStack(alignment: .leading, spacing: 1) {
                    Text((url.host() ?? "").replacingOccurrences(of: "www.", with: "", options: .anchored)).font(.inter(12, .bold)).foregroundStyle(Color.chInk)
                    Text(url.absoluteString).font(.inter(12)).foregroundStyle(Color.chCaption).lineLimit(1).truncationMode(.tail)
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 12).padding(.vertical, 10)
            .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Color.chInk.opacity(0.1)))
            .contentShape(.rect(cornerRadius: 12))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Link: \(url.host() ?? url.absoluteString)")
    }
}

/// 1–4 photos laid out as the website does (.social-photos n-1…n-4).
struct PhotoGrid: View {
    let photos: [SocialPhoto]
    let open: (Int) -> Void

    var body: some View {
        Group {
            switch photos.count {
            case 1:
                tile(0).frame(height: 260)
            case 2:
                HStack(spacing: 4) { tile(0); tile(1) }.aspectRatio(16 / 9, contentMode: .fit)
            case 3:
                HStack(spacing: 4) {
                    tile(0).containerRelativeFrame(.horizontal) { w, _ in w * 0.55 }
                    VStack(spacing: 4) { tile(1); tile(2) }
                }
                .aspectRatio(16 / 9, contentMode: .fit)
            default:
                Grid(horizontalSpacing: 4, verticalSpacing: 4) {
                    GridRow { tile(0); tile(1) }
                    GridRow { tile(2); tile(3) }
                }
                .aspectRatio(16 / 9, contentMode: .fit)
            }
        }
        .clipShape(.rect(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(Color.chInk.opacity(0.08)))
    }

    private func tile(_ i: Int) -> some View {
        Button { open(i) } label: {
            Color.clear.overlay { RemoteImage(url: photos[i].fullURL, points: photos.count == 1 ? 600 : 320) }.clipped()
        }
        .buttonStyle(.plain)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityLabel("Open photo \(i + 1) of \(photos.count)")
        .accessibilityIdentifier("postPhoto")
    }
}

struct PhotoViewerItem: Identifiable {
    let id = UUID()
    let photos: [SocialPhoto]
    let index: Int
}

/// Full-screen photos, swipe between them (the website's lightbox).
struct PhotoViewer: View {
    let item: PhotoViewerItem
    @State private var index = 0
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        ZStack(alignment: .topTrailing) {
            Color.black.ignoresSafeArea()
            TabView(selection: $index) {
                ForEach(Array(item.photos.enumerated()), id: \.offset) { i, photo in
                    RemoteImage(url: photo.fullURL, points: 1400, contentMode: .fit)
                        .tag(i)
                        .accessibilityLabel("Photo \(i + 1) of \(item.photos.count)")
                }
            }
            .tabViewStyle(.page(indexDisplayMode: item.photos.count > 1 ? .always : .never))
            Button { dismiss() } label: {
                Image(systemName: "xmark").font(.system(size: 16, weight: .bold)).foregroundStyle(.white)
                    .frame(width: 44, height: 44).background(.white.opacity(0.14), in: Circle())
            }
            .padding(16)
            .accessibilityLabel("Close")
        }
        .onAppear { index = item.index }
    }
}
