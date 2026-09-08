import Logo from "./Logo";

export default function Footer() {
  return (
    <footer className="border-t border-visiyon-border py-14">
      <div className="max-w-6xl mx-auto px-6">
        <div className="flex flex-wrap justify-between gap-10 pb-10">
          <div>
            <Logo />
            <p className="text-[13.5px] text-visiyon-text-3 max-w-[220px] mt-3.5 leading-relaxed">
              A self-hosted assistant built on open models, running entirely on your infrastructure.
            </p>
          </div>
          <div className="flex gap-16 flex-wrap">
            <div>
              <h5 className="text-[13px] text-visiyon-text-3 font-semibold mb-4">Product</h5>
              <a href="#models" className="block text-[13.5px] text-visiyon-text-2 hover:text-visiyon-text mb-3 transition-colors">Models</a>
              <a href="#features" className="block text-[13.5px] text-visiyon-text-2 hover:text-visiyon-text mb-3 transition-colors">Features</a>
              <a href="#faq" className="block text-[13.5px] text-visiyon-text-2 hover:text-visiyon-text mb-3 transition-colors">FAQ</a>
            </div>
            <div>
              <h5 className="text-[13px] text-visiyon-text-3 font-semibold mb-4">Account</h5>
              <a href="/login" className="block text-[13.5px] text-visiyon-text-2 hover:text-visiyon-text mb-3 transition-colors">Log in</a>
              <a href="/register" className="block text-[13.5px] text-visiyon-text-2 hover:text-visiyon-text mb-3 transition-colors">Sign up</a>
            </div>
          </div>
        </div>
        <div className="flex flex-wrap justify-between gap-3 pt-7 border-t border-visiyon-border text-[12.5px] text-visiyon-text-3">
          <span>© 2026 Visiyon AI. Self-hosted, open source.</span>
          <span>Visiyon AI can make mistakes. Please double-check responses.</span>
        </div>
      </div>
    </footer>
  );
}
