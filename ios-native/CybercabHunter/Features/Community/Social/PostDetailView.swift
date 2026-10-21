import SwiftUI
import Observation

/// A post's comments (worker/social.js): 10 top-level comments a page, oldest
/// first, each with its replies (one level: a reply to a reply joins the same
/// thread on the server).
@MainActor
@Observable
final class CommentsModel {
    let postID: String
    private(set) var comments: [SocialComment] = []
    private(set) var nextCursor: String?
    private(set) var state: State = .loading
    private(set) var sending = false
    enum State: Equatable { case loading, loaded, failed }

    init(postID: String) { self.postID = postID }

    func load(api: APIClient, more: Bool = false) async {
        if !more { state = comments.isEmpty ? .loading : state }
        var query: [URLQueryItem] = []
        if more, let c = nextCursor { query.append(URLQueryItem(name: "cursor", value: c)) }
        do {
            let page: SocialCommentsPage = try await api.get("/api/social/posts/\(postID)/comments", query: query, authenticated: true)
            comments = more ? comments + page.comments.filter { c in !comments.contains { $0.id == c.id } } : page.comments
            nextCursor = page.nextCursor
            state = .loaded
        } catch is CancellationError {
        } catch {
            if comments.isEmpty { state = .failed }
        }
    }

    /// A new comment or reply; returns the post's new comment count, or an error message.
    func add(_ body: String, parent: SocialComment?, api: APIClient) async -> Result<Int, CommentError> {
        guard !sending else { return .failure(CommentError(message: "")) }
        sending = true
        defer { sending = false }
        var json: [String: Any] = ["body": body]
        if let parent { json["parent_id"] = parent.id }
        do {
            let r: SocialCommentCreated = try await api.send("/api/social/posts/\(postID)/comments", method: "POST", body: JSONBody.make(json))
            if let top = r.comment.parentId, let i = comments.firstIndex(where: { $0.id == top }) {
                comments[i].replies = (comments[i].replies ?? []) + [r.comment]
            } else {
                comments.append(r.comment)
            }
            return .success(r.commentCount)
        } catch { return .failure(CommentError(message: SocialText.message(for: error), unauthorized: error as? APIError == .unauthorized)) }
    }

    func edit(_ comment: SocialComment, body: String, api: APIClient) async -> CommentError? {
        guard !sending else { return nil }
        sending = true
        defer { sending = false }
        do {
            let r: SocialCommentUpdated = try await api.send("/api/social/comments/\(comment.id)", method: "PATCH", body: JSONBody.make(["body": body]))
            replace(comment.id) { $0.body = r.comment.body; $0.editedAt = r.comment.editedAt }
            return nil
        } catch { return CommentError(message: SocialText.message(for: error), unauthorized: error as? APIError == .unauthorized) }
    }

    /// The author's delete (its replies go too) or a moderator's removal (a placeholder stays).
    func delete(_ comment: SocialComment, api: APIClient) async -> Result<Int, CommentError> {
        do {
            let r: SocialCommentDeleted = try await api.send("/api/social/comments/\(comment.id)", method: "DELETE")
            if comment.mine {
                comments.removeAll { $0.id == comment.id }
                for i in comments.indices { comments[i].replies?.removeAll { $0.id == comment.id } }
            } else {
                await load(api: api)
            }
            return .success(r.commentCount)
        } catch { return .failure(CommentError(message: SocialText.message(for: error), unauthorized: error as? APIError == .unauthorized)) }
    }

    private func replace(_ id: String, _ change: (inout SocialComment) -> Void) {
        for i in comments.indices {
            if comments[i].id == id { change(&comments[i]); return }
            if let j = comments[i].replies?.firstIndex(where: { $0.id == id }) { change(&comments[i].replies![j]); return }
        }
    }
}

struct CommentError: Error, Equatable { let message: String; var unauthorized = false }

/// A post's own screen (the website's /community?post=<id>): the post, its
/// comments and replies, and the comment box.
struct PostDetailView: View {
    let route: PostRoute
    let social: SocialFeedModel

    @Environment(SessionStore.self) private var session
    @Environment(\.openSignIn) private var openSignIn
    @State private var comments: CommentsModel
    @State private var state: LoadState = .loading
    @State private var draft = ""
    @State private var replyTo: SocialComment?
    @State private var editing: SocialComment?
    @State private var commentError: String?
    @State private var reportComment: SocialComment?
    @State private var deleteComment: SocialComment?
    @FocusState private var inputFocused: Bool

    enum LoadState: Equatable { case loading, loaded, unavailable, failed }

    init(route: PostRoute, social: SocialFeedModel) {
        self.route = route
        self.social = social
        _comments = State(initialValue: CommentsModel(postID: route.id))
    }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    if let post = social.posts[route.id], state != .unavailable {
                        PostCard(post: post, social: social, single: true)
                        thread(proxy: proxy)
                    } else if state == .unavailable {
                        EmptyStateCard(title: "This post isn't available", text: "It may have been deleted by its author or removed by moderators.")
                            .accessibilityIdentifier("postUnavailable")
                    } else if state == .failed {
                        EmptyStateCard(title: "We couldn't load this post", text: "Please try again in a moment.")
                    } else {
                        PanelSkeleton(height: 220)
                    }
                }
                .padding(16)
            }
            .refreshable { await load(proxy: proxy) }
            .task { await load(proxy: proxy) }
        }
        .appBackground()
        .navigationTitle("Post")
        .navigationBarTitleDisplayMode(.inline)
        .safeAreaInset(edge: .bottom) { if state == .loaded { inputBar } }
        .sheet(item: $reportComment) { ReportSheet(kind: "comment", id: $0.id, social: social) }
        .confirmationDialog(deleteComment?.mine == true ? "Delete your comment?" : "Remove this comment for everyone?",
                            isPresented: Binding(get: { deleteComment != nil }, set: { if !$0 { deleteComment = nil } }), titleVisibility: .visible) {
            Button(deleteComment?.mine == true ? "Delete" : "Remove", role: .destructive) {
                if let c = deleteComment { Task { await remove(c) } }
            }
        } message: { Text(deleteComment?.mine == true ? "Replies to it go too." : "It's hidden and logged for moderators.") }
        .overlay(alignment: .top) { ToastOverlay(social: social) }
    }

    private func load(proxy: ScrollViewProxy) async {
        do {
            _ = try await social.loadPost(route.id)
            state = .loaded
            await comments.load(api: session.api)
            if let target = route.commentId {
                try? await Task.sleep(for: .milliseconds(250))
                withAnimation { proxy.scrollTo(target, anchor: .center) }
            }
        } catch is CancellationError {
        } catch APIError.http(let status, _) where status == 404 || status == 400 {
            state = .unavailable
        } catch {
            state = social.posts[route.id] == nil ? .failed : .loaded
        }
    }

    @ViewBuilder private func thread(proxy: ScrollViewProxy) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("COMMENTS").font(.inter(11, .bold)).tracking(1.4).foregroundStyle(Color.brandGold)
            switch comments.state {
            case .loading: ProgressView().tint(Color.chFog).frame(maxWidth: .infinity)
            case .failed: Text("Comments could not be loaded.").font(.inter(13)).foregroundStyle(Color.chFog)
            case .loaded:
                if comments.comments.isEmpty {
                    Text("No comments yet. Start the conversation.").font(.inter(13)).foregroundStyle(Color.chFog)
                        .accessibilityIdentifier("noComments")
                }
                ForEach(comments.comments) { c in
                    CommentRow(comment: c, isReply: false, highlighted: c.id == route.commentId, signedIn: social.viewer.signedIn, actions: actions)
                        .id(c.id)
                    ForEach(c.replies ?? []) { r in
                        CommentRow(comment: r, isReply: true, highlighted: r.id == route.commentId, signedIn: social.viewer.signedIn, actions: actions)
                            .id(r.id)
                            .padding(.leading, 36)
                    }
                }
                if comments.nextCursor != nil {
                    Button("Load more comments") { Task { await comments.load(api: session.api, more: true) } }
                        .font(.inter(13, .semibold))
                }
            }
            if !social.viewer.signedIn {
                HStack(spacing: 4) {
                    Button("Sign in") { openSignIn() }.font(.inter(13, .semibold))
                    Text("to comment.").font(.inter(13)).foregroundStyle(Color.chFog)
                }
            }
        }
        .padding(14)
        .background(Color.chSurface, in: .rect(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Color.chInk.opacity(0.08)))
    }

    private var actions: CommentRow.Actions {
        CommentRow.Actions(
            reply: { c in editing = nil; replyTo = c; draft = ""; inputFocused = true },
            edit: { c in replyTo = nil; editing = c; draft = c.body ?? ""; inputFocused = true },
            delete: { c in deleteComment = c },
            report: { c in reportComment = c }
        )
    }

    @ViewBuilder private var inputBar: some View {
        if social.viewer.signedIn {
            VStack(alignment: .leading, spacing: 6) {
                if let r = replyTo ?? editing {
                    HStack {
                        Text(editing != nil ? "Editing your comment" : "Replying to \(r.author.name)").font(.inter(12, .semibold)).foregroundStyle(Color.brandGold)
                        Spacer()
                        Button("Cancel") { replyTo = nil; editing = nil; draft = "" }.font(.inter(12, .semibold))
                    }
                }
                if let commentError {
                    Text(commentError).font(.inter(12, .semibold)).foregroundStyle(Color(hex: 0xF08A84)).accessibilityIdentifier("commentError")
                }
                HStack(alignment: .bottom, spacing: 8) {
                    TextField(editing != nil ? "Edit your comment" : replyTo.map { "Reply to \($0.author.name)" } ?? "Add a comment", text: $draft, axis: .vertical)
                        .lineLimit(1...5)
                        .font(.inter(15))
                        .focused($inputFocused)
                        .padding(.horizontal, 12).padding(.vertical, 9)
                        .background(Color.chBackground, in: .rect(cornerRadius: 18))
                        .overlay(RoundedRectangle(cornerRadius: 18).strokeBorder(Color.chHair2))
                        .onChange(of: draft) { if draft.utf16.count > 1000 { draft = String(draft.prefix(1000)) } }
                        .accessibilityIdentifier("commentInput")
                    Button(editing != nil ? "Save" : replyTo != nil ? "Reply" : "Comment") { Task { await send() } }
                        .buttonStyle(GoldButtonStyle(small: true))
                        .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || comments.sending)
                        .accessibilityIdentifier("commentSend")
                }
            }
            .padding(.horizontal, 12).padding(.vertical, 8)
            .background(.bar)
        }
    }

    private func send() async {
        let body = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !body.isEmpty else { return }
        commentError = nil
        if let c = editing {
            if let e = await comments.edit(c, body: body, api: session.api) { handle(e); return }
        } else {
            switch await comments.add(body, parent: replyTo, api: session.api) {
            case .success(let n): social.setCommentCount(route.id, n)
            case .failure(let e): handle(e); return
            }
        }
        draft = ""; replyTo = nil; editing = nil; inputFocused = false
    }

    private func remove(_ c: SocialComment) async {
        deleteComment = nil
        switch await comments.delete(c, api: session.api) {
        case .success(let n): social.setCommentCount(route.id, n)
        case .failure(let e): social.toast = .init(text: e.message, isError: true)
        }
    }

    private func handle(_ e: CommentError) {
        if e.unauthorized { session.signOut(); social.signedOut(); openSignIn() }
        if !e.message.isEmpty { commentError = e.message }
    }
}

/// One comment or reply (the website's .social-comment).
struct CommentRow: View {
    struct Actions {
        let reply: (SocialComment) -> Void
        let edit: (SocialComment) -> Void
        let delete: (SocialComment) -> Void
        let report: (SocialComment) -> Void
    }
    let comment: SocialComment
    let isReply: Bool
    var highlighted = false
    let signedIn: Bool
    let actions: Actions

    var body: some View {
        if comment.removed {
            Text("Comment removed by moderators.").font(.inter(13).italic()).foregroundStyle(Color.chFog)
                .padding(.horizontal, 12).padding(.vertical, 6)
        } else {
            HStack(alignment: .top, spacing: 8) {
                PersonAvatar(comment.author, size: 26)
                VStack(alignment: .leading, spacing: 4) {
                    VStack(alignment: .leading, spacing: 3) {
                        HStack(spacing: 5) {
                            AuthorName(author: comment.author, size: 13)
                            RankLevel(rank: comment.author.rank, level: comment.author.level)
                        }
                        Text(SocialText.relative(comment.createdAt) + (comment.editedAt != nil ? " · edited" : ""))
                            .font(.inter(11.5)).foregroundStyle(Color.chCaption)
                        LinkedText(text: comment.body ?? "", size: 14)
                    }
                    .padding(.horizontal, 12).padding(.vertical, 8)
                    .background(Color.chInk.opacity(0.04), in: .rect(cornerRadius: 12))
                    .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(highlighted ? Color.brandGold.opacity(0.55) : .clear, lineWidth: 2))
                    HStack(spacing: 14) {
                        if !isReply && signedIn { Button("Reply") { actions.reply(comment) }.accessibilityIdentifier("commentReply") }
                        if comment.canEdit { Button("Edit") { actions.edit(comment) } }
                        if comment.canDelete { Button(comment.mine ? "Delete" : "Remove") { actions.delete(comment) } }
                        if signedIn && !comment.mine { Button("Report") { actions.report(comment) } }
                    }
                    .buttonStyle(.plain)
                    .font(.inter(12, .semibold))
                    .foregroundStyle(Color.chCaption)
                    .padding(.leading, 12)
                }
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("comment-\(comment.id)")
        }
    }
}

/// A dashed "nothing here" / error card (css .social-empty).
struct EmptyStateCard: View {
    let title: String
    let text: String
    var body: some View {
        VStack(spacing: 4) {
            Text(title).font(.inter(15, .bold)).foregroundStyle(Color.chInk)
            Text(text).font(.inter(13)).foregroundStyle(Color.chFog).multilineTextAlignment(.center)
        }
        .padding(.vertical, 28).padding(.horizontal, 20)
        .frame(maxWidth: .infinity)
        .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(Color.chInk.opacity(0.12), style: StrokeStyle(lineWidth: 1, dash: [5, 4])))
    }
}

/// The model's toast, shown briefly at the top.
struct ToastOverlay: View {
    let social: SocialFeedModel
    var body: some View {
        Group {
            if let toast = social.toast {
                ToastBanner(text: toast.text, isError: toast.isError)
                    .padding(.top, 8)
                    .transition(.move(edge: .top).combined(with: .opacity))
                    .task(id: toast.id) {
                        try? await Task.sleep(for: .seconds(2.6))
                        if social.toast?.id == toast.id { withAnimation { social.toast = nil } }
                    }
            }
        }
        .animation(.snappy, value: social.toast)
    }
}
