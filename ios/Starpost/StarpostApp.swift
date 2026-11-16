import SwiftUI

@main
struct StarpostApp: App {
    @StateObject private var identity = IdentityModel()
    var body: some Scene {
        WindowGroup {
            RootView().environmentObject(identity)
                .task { await identity.restore() }
                .onOpenURL { url in Task { await identity.handleCallback(url) } }
        }
    }
}

struct RootView: View {
    @EnvironmentObject private var identity: IdentityModel
    @Environment(\.scenePhase) private var phase
    @State private var reload = 0
    @State private var showAbout = false
    @State private var confirmLogout = false
    private let timer = Timer.publish(every: 15, on: .main, in: .common).autoconnect()

    var body: some View {
        VStack(spacing: 0) {
            if let session = identity.session {
                HStack(spacing: 12) {
                    Image(systemName: "envelope.badge.shield.half.filled").foregroundStyle(.indigo)
                    Text("星邮").font(.headline)
                    Text(session.humanId).font(.caption).foregroundStyle(.secondary)
                    Spacer()
                    if identity.busy { ProgressView().controlSize(.small) }
                    Menu {
                        Button("刷新页面", systemImage: "arrow.clockwise") { reload += 1 }
                        Button("关于 iOS 版", systemImage: "info.circle") { showAbout = true }
                        Button("切换账号／退出", systemImage: "rectangle.portrait.and.arrow.right", role: .destructive) { confirmLogout = true }
                    } label: {
                        Image(systemName: "ellipsis.circle").font(.title3).frame(minWidth: 44, minHeight: 44)
                    }.accessibilityLabel("星邮菜单")
                }.padding(.horizontal, 16).background(.regularMaterial)
                Divider()
                StarpostWebView(session: session, reload: reload) {
                    Task { await identity.webSessionEnded(session) }
                }.id(session.storeIdentifier)
            } else {
                login
            }
        }
        .tint(.indigo)
        .background(Color(uiColor: .systemGroupedBackground))
        .overlay {
            if phase != .active {
                ZStack {
                    Color(uiColor: .systemBackground).ignoresSafeArea()
                    Label("星邮", systemImage: "envelope.fill").font(.largeTitle.bold()).foregroundStyle(.indigo)
                }.allowsHitTesting(false)
            }
        }
        .onChange(of: phase) { _, next in if next == .active { Task { await identity.foreground() } } }
        .onReceive(timer) { _ in if phase == .active { Task { await identity.checkExpiration() } } }
        .confirmationDialog("退出当前星邮账号？", isPresented: $confirmLogout, titleVisibility: .visible) {
            Button("退出并重新选择账号", role: .destructive) { Task { await identity.signOut() } }
        } message: { Text("聊天记录仍保留在服务器，本机登录凭据会被移除。") }
        .sheet(isPresented: $showAbout) { about }
    }

    private var login: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                Spacer(minLength: 32)
                ZStack(alignment: .topTrailing) {
                    RoundedRectangle(cornerRadius: 28).fill(.indigo.gradient).frame(width: 92, height: 92)
                    Image(systemName: "envelope.fill").font(.system(size: 40)).foregroundStyle(.white).frame(width: 92, height: 92)
                    Image(systemName: "sparkle").foregroundStyle(.mint).font(.title).offset(x: 6, y: -6)
                }
                VStack(alignment: .leading, spacing: 10) {
                    Text("把日常，寄给彼此。").font(.largeTitle.bold())
                    Text("欢迎来到星邮").font(.title2)
                    Text("聊天、动态、漂流瓶，还有你和 bot 的专属会话。").foregroundStyle(.secondary)
                }
                VStack(alignment: .leading, spacing: 16) {
                    Label("使用 FFA hub 登录", systemImage: "person.crop.circle.badge.checkmark").font(.headline)
                    Text("在系统浏览器中验证身份；同一 Hub 下有多个星邮账号时，可以选择本次登录的账号。").font(.subheadline).foregroundStyle(.secondary)
                    if identity.busy { ProgressView("正在安全连接…").frame(maxWidth: .infinity) }
                    else if identity.hasSavedSession {
                        Button("重试验证登录") { Task { await identity.verifySaved() } }.buttonStyle(.borderedProminent)
                        Button("退出已保存的账号", role: .destructive) { Task { await identity.signOut() } }
                    } else if identity.pending != nil {
                        Button("完成登录") { Task { await identity.finishLogin() } }.buttonStyle(.borderedProminent)
                        HStack {
                            Button("重新打开 Hub") { identity.reopenLogin() }
                            Spacer()
                            Button("取消") { identity.cancelLogin() }
                        }
                    } else {
                        Button { Task { await identity.startLogin() } } label: {
                            Label("前往 FFA hub", systemImage: "arrow.up.right").frame(maxWidth: .infinity).padding(.vertical, 8)
                        }.buttonStyle(.borderedProminent)
                    }
                    if let message = identity.message {
                        Text(message).font(.subheadline).foregroundStyle(.secondary).accessibilityAddTraits(.updatesFrequently)
                    }
                }.padding(24).background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 28))
                Label("登录有效期 14 天 · 凭据保存在本机钥匙串", systemImage: "lock.shield").font(.footnote).foregroundStyle(.secondary)
                HStack {
                    Link("星邮官网", destination: StarpostIdentity.origin)
                    Spacer()
                    Button("关于 iOS 版") { showAbout = true }
                }.font(.footnote)
            }.padding(24).frame(maxWidth: 580)
        }.frame(maxWidth: .infinity)
    }

    private var about: some View {
        NavigationStack {
            List {
                Section("星邮 iOS · 0.1.0") {
                    Text("原生 iOS 外壳，复用星邮移动网页。支持现有的聊天、资料、动态、漂流瓶与游戏页面。")
                    Text("本版只在前台收发；后台与锁屏通知尚未接入。")
                }
                Section("隐私与账号") {
                    Text("Hub 密码由系统登录窗口处理。原生登录凭据保存在钥匙串，网页使用受保护的会话 Cookie；网页数据按 Hub 身份与星邮账号隔离。")
                    Text("相机和麦克风仅在使用相关功能时请求。退出会清除登录凭据，账号的本地表情收藏与背景设置仍按账号保留。")
                }
                Section("测试版安装") {
                    Text("无签名 IPA 需要在安装前由你选择的合法签名方式签名。本版不提供 App Store 分发或 APK 式自动覆盖安装。")
                }
                Section { Link("星邮官网", destination: StarpostIdentity.origin) }
            }.navigationTitle("关于星邮").toolbar { Button("完成") { showAbout = false } }
        }
    }
}
