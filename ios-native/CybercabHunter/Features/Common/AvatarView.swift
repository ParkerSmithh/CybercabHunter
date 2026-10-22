import SwiftUI

/// The rider's photo, or their initial on gold when there is none.
struct AvatarView: View {
    let user: MeResponse.User
    var size: CGFloat = 40

    var body: some View {
        AsyncImage(url: user.avatarURL) { phase in
            if let image = phase.image {
                image.resizable().scaledToFill()
            } else {
                Text(String((user.displayName ?? "?").prefix(1)).uppercased())
                    .font(.system(size: size * 0.45, weight: .bold))
                    .foregroundStyle(Color.appBackground)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(Color.brandGold)
            }
        }
        .frame(width: size, height: size)
        .clipShape(Circle())
        .accessibilityHidden(true)
    }
}
