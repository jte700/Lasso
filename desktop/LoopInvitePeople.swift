// Add Reviewers, after the Invite People component of the motion studies
// (designbookmark.com/motion#db-invite-people), in The Loop's colours and
// Figtree. Type an address and add it: the address leaves the field as a pill
// (the field clears under it), the pill narrows to a circle while its words
// blur out, a face pops inside it and it arcs into the front of the stack,
// where the other faces have slid one place right to make room, and lands
// with a little overshoot. Hover a face and it lifts, its neighbours lean
// away, the count rolls to "Remove Dana" and a cross shows; a click takes them
// out. Past five faces the rest fold into a +N bubble. The button rolls to
// "Added" on lime, then back. A bad address shakes the field and turns red.
//
// The springs are the component's own (its tokens.css), stiffness and damping
// at mass 1, as its spring engine steps them.

import SwiftUI

/// The component's springs: "stiffness damping" from its tokens.
enum LoopInviteSprings {
    static let pop = Animation.interpolatingSpring(mass: 1, stiffness: 520, damping: 16)
    static let soft = Animation.interpolatingSpring(mass: 1, stiffness: 260, damping: 24)
    static let fade = Animation.interpolatingSpring(mass: 1, stiffness: 420, damping: 32)
    static let settle = Animation.interpolatingSpring(mass: 1, stiffness: 280, damping: 22)
}

/// A line of words that rolls to new ones: the old slide up and blur out, the new rise in.
struct LoopRollText: View {
    let text: String
    var height: CGFloat = 18
    var alignment: Alignment = .trailing

    var body: some View {
        ZStack(alignment: alignment) {
            Text(text)
                .lineLimit(1).fixedSize()
                .id(text)
                .transition(.asymmetric(
                    insertion: .modifier(active: LoopRolled(y: height, shown: 0), identity: LoopRolled(y: 0, shown: 1)),
                    removal: .modifier(active: LoopRolled(y: -height, shown: 0), identity: LoopRolled(y: 0, shown: 1))))
        }
        .frame(maxWidth: .infinity, maxHeight: height, alignment: alignment)
        .frame(height: height)
        .clipped()
        .animation(LoopInviteSprings.fade, value: text)
    }
}

struct LoopRolled: ViewModifier {
    let y: CGFloat
    let shown: Double

    func body(content: Content) -> some View {
        content.offset(y: y).opacity(shown).blur(radius: (1 - shown) * 2)
    }
}

/// The field's shake: a push of 420 points a second on a 700/12 spring, drawn at half its size, as the component's.
struct LoopInviteShake: GeometryEffect {
    var progress: CGFloat
    var animatableData: CGFloat {
        get { progress }
        set { progress = newValue }
    }

    func effectValue(size: CGSize) -> ProjectionTransform {
        let fraction = progress - progress.rounded(.down)
        guard fraction > 0 else { return ProjectionTransform(.identity) }
        let omega = (700.0).squareRoot()
        let zeta = 12 / (2 * omega)
        let damped = omega * (1 - zeta * zeta).squareRoot()
        let time = Double(fraction) * 0.9
        let x = 420 / damped * exp(-zeta * omega * time) * sin(damped * time) * 0.5
        return ProjectionTransform(CGAffineTransform(translationX: CGFloat(x), y: 0))
    }
}

/// Buttons dip to 94% while pressed, as every button of the component does.
struct LoopDipButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.94 : 1)
            .animation(.timingCurve(0.23, 1, 0.32, 1, duration: configuration.isPressed ? 0.12 : 0.22), value: configuration.isPressed)
    }
}

struct LoopInvitePeople: View {
    @Binding var people: [LoopInvitee]
    var title = "Add Reviewers"
    var placeholder = "name@company.com"

    @State private var text = ""
    @State private var hovered: String?
    @State private var bad = false
    @State private var shakes: CGFloat = 0
    @State private var added = false
    /// Faces moved over for an address still in flight.
    @State private var opening = 0
    @State private var flights: [Flight] = []
    @State private var fieldFrame: CGRect = .zero
    @State private var stackFrame: CGRect = .zero
    @State private var landing: String?
    @FocusState private var focused: Bool

    private static let gap: CGFloat = 28
    private static let face: CGFloat = 40
    private static let shown = 5
    private static let flightTime = 0.95

    struct Flight: Identifiable, Equatable {
        let id = UUID()
        let person: LoopInvitee
        let start: Date
        let from: CGPoint
        let to: CGPoint
        let width: CGFloat
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                Text(title).font(LoopLook.font(18, .semibold)).foregroundStyle(LoopLook.ink).fixedSize()
                LoopRollText(text: count).font(LoopLook.font(13)).foregroundStyle(LoopLook.ink3).monospacedDigit()
            }
            stack
                .frame(height: 44)
                .padding(.top, 14).padding(.bottom, 16)
            form
        }
        .coordinateSpace(name: "invite")
        .overlay(alignment: .topLeading) { flying }
    }

    // MARK: Count

    private var count: String {
        if let hovered, let person = people.first(where: { $0.id == hovered }) {
            return "Remove \(person.name.split(separator: " ").first.map(String.init) ?? person.name)"
        }
        let total = people.count + flights.count
        return total == 0 ? "No reviewers yet" : total == 1 ? "1 reviewer" : "\(total) reviewers"
    }

    // MARK: Faces

    private var stack: some View {
        let hoveredIndex = hovered.flatMap { id in people.firstIndex { $0.id == id } }
        let extra = people.count + opening - Self.shown
        return ZStack(alignment: .topLeading) {
            more(extra)
            ForEach(Array(people.enumerated()), id: \.element.id) { index, person in
                faceButton(person, index: index, hoveredIndex: hoveredIndex)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(GeometryReader { proxy in
            Color.clear.onAppear { stackFrame = proxy.frame(in: .named("invite")) }
                .onChange(of: proxy.frame(in: .named("invite"))) { stackFrame = $0 }
        })
        .animation(LoopInviteSprings.soft, value: opening)
        .animation(LoopInviteSprings.soft, value: people)
        .animation(LoopInviteSprings.settle, value: hovered)
    }

    private func more(_ extra: Int) -> some View {
        LoopRollText(text: extra > 0 ? "+\(extra)" : "", height: 34, alignment: .center)
            .font(LoopLook.font(12, .semibold)).foregroundStyle(LoopLook.ink2).monospacedDigit()
            .frame(width: 34, height: 34)
            .background(Circle().fill(LoopLook.lift))
            .frame(width: Self.face, height: Self.face)
            .scaleEffect(extra > 0 ? 1 : 0.001)
            .offset(x: CGFloat(min(Self.shown, people.count + opening)) * Self.gap, y: 2)
            .animation(LoopInviteSprings.pop, value: extra > 0)
            .animation(LoopInviteSprings.soft, value: people.count + opening)
    }

    private func faceButton(_ person: LoopInvitee, index: Int, hoveredIndex: Int?) -> some View {
        let slot = index + opening
        let visible = slot < Self.shown
        let isHovered = hoveredIndex == index
        // Hovered lifts 5; its neighbours lean away, less the further they are.
        let lean: CGFloat = hoveredIndex.map { hovered in
            index == hovered ? 0 : (index < hovered ? -1 : 1) * max(0, 6 - 2 * CGFloat(abs(index - hovered)))
        } ?? 0
        return Button { remove(person) } label: {
            ZStack {
                LoopReviewAvatar(actor: LoopReviewActor(id: "email:\(person.email)", name: person.name, type: "HUMAN_COLLABORATOR"),
                                  size: Self.face - 6)
                Circle().fill(Color.black.opacity(0.5))
                    .overlay(Image(systemName: "xmark").font(.system(size: 11, weight: .bold)).foregroundStyle(Color.white))
                    .frame(width: Self.face - 6, height: Self.face - 6)
                    .opacity(isHovered ? 1 : 0)
                    .animation(.easeOut(duration: 0.18), value: isHovered)
            }
            .frame(width: Self.face, height: Self.face)
            .background(Circle().fill(LoopLook.raise))
            .contentShape(Circle())
        }
        .buttonStyle(LoopDipButtonStyle())
        .help("\(person.name), \(person.email). Click to remove")
        .accessibilityLabel("\(person.name). Remove")
        .onHover { inside in
            if inside { hovered = person.id } else if hovered == person.id { hovered = nil }
        }
        .scaleEffect(visible ? (isHovered ? 1.08 : 1) : 0.001)
        .offset(x: CGFloat(slot) * Self.gap + lean, y: 2 + (isHovered ? -5 : 0))
        .zIndex(Double(20 - index))
        .disabled(!visible)
        .transition(.asymmetric(insertion: .modifier(active: LoopFacePop(scale: 0.82), identity: LoopFacePop(scale: 1)),
                                removal: .modifier(active: LoopFacePop(scale: 0.001), identity: LoopFacePop(scale: 1))))
        .animation(LoopInviteSprings.pop, value: visible)
    }

    // MARK: Field

    private var form: some View {
        HStack(spacing: 8) {
            TextField(placeholder, text: $text)
                .textFieldStyle(.plain)
                .font(LoopLook.font(14.5, .medium))
                .foregroundStyle(bad ? LoopLook.terracottaSoft : LoopLook.ink)
                .focused($focused)
                .onSubmit(add)
                .onChange(of: text) { _ in if bad { withAnimation(.easeOut(duration: 0.25)) { bad = false } } }
                .padding(.horizontal, 16)
                .frame(height: 44)
                .background(Capsule().fill(LoopLook.raise))
                .overlay(Capsule().strokeBorder(focused ? LoopLook.line : .clear, lineWidth: 1))
                .background(GeometryReader { proxy in
                    Color.clear.onAppear { fieldFrame = proxy.frame(in: .named("invite")) }
                        .onChange(of: proxy.frame(in: .named("invite"))) { fieldFrame = $0 }
                })
            Button(action: add) {
                LoopRollText(text: added ? "\u{2713} Added" : "Add", height: 20, alignment: .center)
                    .font(LoopLook.font(14.5, .semibold))
                    .foregroundStyle(LoopLook.onInk)
                    .frame(width: 86, height: 44)
                    .background(Capsule().fill(added ? LoopLook.lime : LoopLook.ink))
                    .animation(.easeOut(duration: 0.3), value: added)
                    .contentShape(Capsule())
            }
            .buttonStyle(LoopDipButtonStyle())
        }
        .modifier(LoopInviteShake(progress: shakes))
        .onAppear { DispatchQueue.main.async { focused = true } }
    }

    // MARK: Adding and taking out

    private func add() {
        let address = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard LoopInvitee.isAddress(address) else {
            withAnimation(.easeOut(duration: 0.25)) { bad = true }
            withAnimation(.linear(duration: 0.9)) { shakes = shakes.rounded(.down) + 0.999 }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.9) {
                shakes = shakes.rounded(.up)
                withAnimation(.easeOut(duration: 0.25)) { bad = false }
            }
            return
        }
        let person = LoopInvitee(email: address)
        guard !people.contains(person), !flights.contains(where: { $0.person == person }) else { text = ""; return }
        // The pill starts where the words were and lands at the front of the stack.
        let from = CGPoint(x: fieldFrame.minX + 4, y: fieldFrame.minY + 5)
        let to = CGPoint(x: stackFrame.minX + 3, y: stackFrame.minY + 2 + 3)
        let width = min(fieldFrame.width - 8, CGFloat(address.count) * 7.6 + 24)
        flights.append(Flight(person: person, start: Date(), from: from, to: to, width: width))
        text = ""
        opening = flights.count
        added = true
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.flightTime) { land(person) }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { if flights.isEmpty { added = false } }
    }

    private func land(_ person: LoopInvitee) {
        flights.removeAll { $0.person == person }
        var instant = Transaction()
        instant.disablesAnimations = true
        withTransaction(instant) { opening = flights.count }
        withAnimation(LoopInviteSprings.pop) { people.insert(person, at: 0) }
    }

    private func remove(_ person: LoopInvitee) {
        if hovered == person.id { hovered = nil }
        withAnimation(LoopInviteSprings.pop) { people.removeAll { $0 == person } }
    }

    // MARK: The flight

    @ViewBuilder private var flying: some View {
        if !flights.isEmpty {
            TimelineView(.animation) { context in
                ZStack(alignment: .topLeading) {
                    ForEach(flights) { flight in
                        LoopInviteFlightView(flight: flight, now: context.date)
                    }
                }
            }
            .allowsHitTesting(false)
        }
    }
}

struct LoopFacePop: ViewModifier {
    let scale: CGFloat

    func body(content: Content) -> some View { content.scaleEffect(scale) }
}

/// One address on its way into the stack, drawn on the clock as the component draws it.
private struct LoopInviteFlightView: View {
    let flight: LoopInvitePeople.Flight
    let now: Date

    var body: some View {
        let t = now.timeIntervalSince(flight.start)
        let a = clamp(t / 0.3)
        let u = inOut(clamp((t - 0.3) / 0.65))
        let width = flight.width + (34 - flight.width) * inOut(a)
        let arc = sin(u * .pi)
        let x = flight.from.x + (flight.to.x - flight.from.x) * u
        let y = flight.from.y - easeOut(a) * 4 + (flight.to.y - flight.from.y + 4) * u - arc * 42
        let words = clamp(1 - a * 1.8)
        let p = clamp((t - 0.22) / 0.25)
        let pop = p <= 0 ? 0 : 1 + sin(p * .pi) * 0.18 * (1 - p) - (1 - p) * (1 - p)
        return ZStack(alignment: .leading) {
            Capsule().fill(LoopLook.lift)
            Text(flight.person.email)
                .font(LoopLook.font(14.5, .medium)).foregroundStyle(LoopLook.ink)
                .lineLimit(1).fixedSize()
                .padding(.leading, 12)
                .opacity(words).blur(radius: (1 - words) * 3)
            LoopReviewAvatar(actor: LoopReviewActor(id: "email:\(flight.person.email)", name: flight.person.name, type: "HUMAN_COLLABORATOR"),
                              size: 34)
                .scaleEffect(max(0, pop))
        }
        .frame(width: width, height: 34, alignment: .leading)
        .clipShape(Capsule())
        .scaleEffect(1 + arc * 0.1)
        .offset(x: x, y: y)
    }

    private func clamp(_ value: Double) -> Double { min(1, max(0, value)) }
    private func easeOut(_ value: Double) -> Double { 1 - pow(1 - value, 3) }
    private func inOut(_ value: Double) -> Double { value < 0.5 ? 4 * value * value * value : 1 - pow(-2 * value + 2, 3) / 2 }
}
