import java.io.File;
import java.util.ArrayList;
import java.util.List;
import javax.xml.XMLConstants;
import javax.xml.transform.stream.StreamSource;
import javax.xml.validation.Schema;
import javax.xml.validation.SchemaFactory;
import javax.xml.validation.Validator;
import org.xml.sax.ErrorHandler;
import org.xml.sax.SAXException;
import org.xml.sax.SAXParseException;

public final class Xsd11Validator {
  private static final String FACTORY_CLASS = "org.opengis.cite.xerces.jaxp.validation.XMLSchema11Factory";

  private Xsd11Validator() {
  }

  public static void main(String[] argv) {
    try {
      Config config = parseArgs(argv);
      validate(config.xsd, config.xml);
      System.out.println("XSD 1.1 validation passed: " + config.xml.getPath());
    } catch (Exception err) {
      System.err.println(err.getMessage());
      System.exit(1);
    }
  }

  private static Config parseArgs(String[] argv) {
    File xsd = null;
    File xml = null;

    for (int i = 0; i < argv.length; i += 1) {
      String arg = argv[i];
      if ("--xsd".equals(arg)) {
        xsd = new File(nextArg(argv, ++i, "--xsd"));
      } else if ("--xml".equals(arg)) {
        xml = new File(nextArg(argv, ++i, "--xml"));
      } else if ("--help".equals(arg) || "-h".equals(arg)) {
        throw new IllegalArgumentException("Usage: Xsd11Validator --xsd schema.xsd --xml sample.xml");
      } else {
        throw new IllegalArgumentException("Unknown argument: " + arg);
      }
    }

    if (xsd == null) throw new IllegalArgumentException("--xsd is required");
    if (xml == null) throw new IllegalArgumentException("--xml is required");
    if (!xsd.isFile()) throw new IllegalArgumentException("XSD file does not exist: " + xsd.getPath());
    if (!xml.isFile()) throw new IllegalArgumentException("XML file does not exist: " + xml.getPath());

    return new Config(xsd, xml);
  }

  private static String nextArg(String[] argv, int index, String flag) {
    if (index >= argv.length) throw new IllegalArgumentException(flag + " requires a value");
    return argv[index];
  }

  private static void validate(File xsd, File xml) throws Exception {
    CollectingErrorHandler errors = new CollectingErrorHandler();
    SchemaFactory factory = (SchemaFactory) Class.forName(FACTORY_CLASS).getDeclaredConstructor().newInstance();
    try {
      factory.setFeature(XMLConstants.FEATURE_SECURE_PROCESSING, true);
    } catch (SAXException ignored) {
      // Some Xerces builds do not expose this feature through the relocated factory.
    }
    factory.setErrorHandler(errors);

    Schema schema = factory.newSchema(source(xsd));
    Validator validator = schema.newValidator();
    validator.setErrorHandler(errors);
    validator.validate(source(xml));

    if (errors.hasFailures()) {
      throw new SAXException(errors.summary());
    }
    errors.printWarnings();
  }

  private static StreamSource source(File file) {
    StreamSource source = new StreamSource(file);
    source.setSystemId(file.toURI().toString());
    return source;
  }

  private static final class Config {
    private final File xsd;
    private final File xml;

    private Config(File xsd, File xml) {
      this.xsd = xsd;
      this.xml = xml;
    }
  }

  private static final class CollectingErrorHandler implements ErrorHandler {
    private final List<String> warnings = new ArrayList<>();
    private final List<String> failures = new ArrayList<>();

    @Override
    public void warning(SAXParseException err) {
      warnings.add(format("warning", err));
    }

    @Override
    public void error(SAXParseException err) {
      failures.add(format("error", err));
    }

    @Override
    public void fatalError(SAXParseException err) throws SAXException {
      failures.add(format("fatal", err));
      throw err;
    }

    private boolean hasFailures() {
      return !failures.isEmpty();
    }

    private String summary() {
      return String.join(System.lineSeparator(), failures);
    }

    private void printWarnings() {
      for (String warning : warnings) {
        System.err.println(warning);
      }
    }

    private static String format(String level, SAXParseException err) {
      return level + ": " + location(err) + ": " + err.getMessage();
    }

    private static String location(SAXParseException err) {
      String systemId = err.getSystemId() == null ? "<unknown>" : err.getSystemId();
      return systemId + ":" + err.getLineNumber() + ":" + err.getColumnNumber();
    }
  }
}
