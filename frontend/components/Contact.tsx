export default function Contact() {
  return (
    <section id="contact" className="py-24 border-t border-visiyon-border">
      <div className="max-w-2xl mx-auto px-6 text-center">
        <h2 className="text-[28px] md:text-[36px] tracking-[-0.02em] font-semibold mb-4">
          Deploy Visiyon on your own server.
        </h2>
        <p className="text-visiyon-text-2 mb-8 leading-relaxed">
          Open source, self-hosted, and built for Ubuntu Server with Docker Compose.
        </p>
        <a
          href="#"
          className="inline-flex items-center justify-center text-[15px] font-medium px-6 py-3 rounded-full bg-white text-black hover:bg-transparent hover:text-visiyon-text border border-visiyon-text transition-colors"
        >
          Get the setup guide
        </a>
      </div>
    </section>
  );
}
